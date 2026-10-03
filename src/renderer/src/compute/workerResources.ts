import { LIB_BASE, DATA_BASE } from '../../../shared/dataSource';
import { createResourceCache } from './resourceCache';
import { makeOptionsKey } from './revisionKey';
import type { KernelResources, S1Kind } from './kernels';

export interface ResourceSpec { key: string; url: string | null; globalKey?: string; digest?: string; optional?: boolean; adapter?: 'analysis-songcharts-v1' }
export interface ResourceManifest { modelRevision: string; dataRevision: string }
const moduleSpec = (file: string, globalKey: string): ResourceSpec => ({ key: globalKey, url: `${LIB_BASE}/${file}`, globalKey });
const norm = moduleSpec('normTitle.js', 'OhsorryNorm');
const weak = moduleSpec('calcWeakness.js', 'OhsorryWeakness');
const json = (key: string, file: string): ResourceSpec => ({ key, url: `${DATA_BASE}/${file}` });
const recommendation = [norm, weak, moduleSpec('recommend.js', 'OhsorryRecommend'),
  json('patterns', 'patterns-dp-1112.json'), json('rateRef', 'rate-reference-slim.json'),
  json('featureScores', 'feature-scores-slim.json'), json('textageMeta', 'textage-meta.json'),
  { key: 'seriesNames', url: 'https://gist.githubusercontent.com/OhSorry-DP/30c3ba6f87df9847291c42ea216a8d2a/raw/series-name.json', optional: true },
  { ...json('weaknessPopMean', 'weakness-popmean.json'), optional: true },
  json('rating', 'ohSorryRating.json'), json('zasa', 'zasa-data.json'), json('ereter', 'ereter-data.json')];
export const DEFAULT_RESOURCES: Record<S1Kind, ResourceSpec[]> = {
  'pattern-score': [norm, weak, json('patterns', 'patterns-dp-1112.json'), { ...json('featureScores', 'feature-scores-slim.json'), optional: true }],
  'dp-star': [norm, moduleSpec('OSR13.5%2B.js', 'OSR135'), moduleSpec('onlyOSR.js', 'onlyOSR'),
    moduleSpec('onlyOSRtoEreter.js', 'onlyOSRtoEreter'), json('rating', 'ohSorryRating.json'), json('ereter', 'ereter-data.json')],
  'r-star': [norm, moduleSpec('userRateStar.js', 'userRateStar'), json('rating', 'ohSorryRating.json')],
  'sp-star': [norm, moduleSpec('cpiStar.js', 'cpiStar'), moduleSpec('spSkillCpi.js', 'spSkillCpi'), json('cpi', 'cpi.json')],
  weakness: [norm, weak, json('patterns', 'patterns-dp-1112.json'), json('rateRef', 'rate-reference-slim.json'),
    json('rating', 'ohSorryRating.json'), json('zasa', 'zasa-data.json')],
  layout: [norm, weak, json('patterns', 'patterns-dp-1112.json'), json('rateRef', 'rate-reference-slim.json'),
    json('rating', 'ohSorryRating.json'), json('zasa', 'zasa-data.json')],
  'rec-context': recommendation,
  'rec-query': recommendation,
};

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Each instance belongs to one Worker realm. No source broker or renderer eval. */
export function createWorkerResources() {
  const sources = createResourceCache<{ text: string; digest: string }>();
  const parsed = createResourceCache<unknown>();
  // Serialize complete dependency chains: globals must never change during another eval/run.
  let tail: Promise<unknown> = Promise.resolve();
  const installedGlobals = new Map<string, string>();
  const defaultGlobals = new Map<string, string>();
  return {
    load(kind: S1Kind, specs: ResourceSpec[] = DEFAULT_RESOURCES[kind]): Promise<{ libs: KernelResources; manifest: ResourceManifest }> {
      const task = tail.then(async () => {
        const analysis = specs.some(spec => spec.adapter === 'analysis-songcharts-v1');
        const libs: KernelResources = {};
        const models: [string, string][] = [], data: [string, string | null][] = [];
        (globalThis as unknown as Record<string, unknown>).window = globalThis;
        for (const spec of specs) {
          if (spec.url === null) {
            if (spec.globalKey) throw new Error(`MISSING_MODEL:${spec.key}`);
            libs[spec.key] = null;
            data.push([spec.key, null]);
            continue;
          }
          let source;
          try { source = await sources.load(makeOptionsKey([spec.url, spec.digest]), async () => {
            const response = await fetch(spec.url!);
            if (!response.ok) throw new Error(`RESOURCE_HTTP:${response.status}:${spec.key}`);
            const text = await response.text();
            return { text, digest: await sha256(text) };
          }); } catch (error) {
            if (!spec.optional) throw error;
            libs[spec.key] = spec.key === 'seriesNames' ? {} : null;
            data.push([spec.key, null]);
            continue;
          }
          if (spec.digest && source.digest !== spec.digest) throw new Error(`RESOURCE_DRIFT:${spec.key}`);
          if (spec.globalKey) {
            const old = installedGlobals.get(spec.globalKey);
            const pinned = defaultGlobals.get(spec.globalKey);
            if (pinned && pinned !== source.digest && !analysis) throw new Error(`MODEL_REALM_DRIFT:${spec.globalKey}`);
            if (!old || old !== source.digest) {
              new Function(source.text)();
            }
            const lib = (globalThis as unknown as Record<string, unknown>)[spec.globalKey];
            if (!lib) throw new Error(`UMD_EXPORT_MISSING:${spec.globalKey}`);
            installedGlobals.set(spec.globalKey, source.digest);
            if (!analysis) defaultGlobals.set(spec.globalKey, source.digest);
            libs[spec.key] = lib;
            models.push([spec.key, source.digest]);
          } else {
            try {
              libs[spec.key] = await parsed.load(makeOptionsKey([spec.url, source.digest]), async () => JSON.parse(source.text));
            } catch (error) {
              if (!spec.optional) throw error;
              libs[spec.key] = spec.key === 'seriesNames' ? {} : null;
            }
            data.push([spec.key, source.digest]);
          }
        }
        const sort = <T extends string | null>(items: [string, T][]) => items.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
        return { libs, manifest: { modelRevision: makeOptionsKey([analysis ? 's4-analysis-adapter-1' : kind.startsWith('rec-') ? 's3-adapter-1' : 's1-adapter-1', sort(models)]),
          dataRevision: makeOptionsKey(sort(data)) } };
      });
      tail = task.catch(() => {});
      return task;
    },
  };
}
