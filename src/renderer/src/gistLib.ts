// gist 로 배포되는 오소리 공용 모듈(calcWeakness / recommend / normTitle / analysisRender)을
// 렌더러에서 쓰기 위한 공통 헬퍼.
//
// Analysis / PlayData / WeaknessRecommend / recommendCore 가 각자 같은 로더·어댑터를
// 복붙해 두고 있어 한 벌로 모았다. window[globalKey] 캐시는 모듈 간 공유된다
// (같은 gist 를 여러 탭에서 중복 fetch 하지 않음).
import type { SongRow, ChartSlot } from '../../shared/types';
import { LAMP_TO_NUM } from '../../shared/match';

// gist 스크립트를 fetch → eval 해서 window[globalKey] 에 심고 그 객체를 돌려준다.
//   force=true 면 이미 로드돼 있어도 다시 fetch (Analysis 의 새로고침 버튼용).
export interface GistSource { source: string; generation: number; value: unknown }
const moduleSources = new Map<string, GistSource>();
const moduleGenerations = new Map<string, number>();
export async function loadGistModuleSource(
  url: string,
  globalKey: string,
  force = false,
): Promise<GistSource> {
  const w = window as unknown as Record<string, unknown>;
  const key = url + '|' + globalKey;
  const cached = moduleSources.get(key);
  if (!force && cached && cached.value === w[globalKey]) return cached;
  const generation = (moduleGenerations.get(key) ?? 0) + 1;
  moduleGenerations.set(key, generation);
  const res = await fetch(`${url}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`${globalKey} fetch HTTP ${res.status}`);
  const text = await res.text();
  if (moduleGenerations.get(key) !== generation) throw new Error('STALE_MODULE_LOAD');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(text)();
  if (!w[globalKey]) throw new Error(`UMD_EXPORT_MISSING:${globalKey}`);
  const record = Object.freeze({ source: text, generation, value: w[globalKey] });
  moduleSources.set(key, record);
  return record;
}
export async function loadGistModule(url: string, globalKey: string, force = false): Promise<unknown> {
  return (await loadGistModuleSource(url, globalKey, force)).value;
}

export async function loadJson<T>(url: string): Promise<T> {
  const res = await fetch(`${url}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`JSON fetch HTTP ${res.status}`);
  return res.json();
}

export interface JsonSource<T> { source: string; value: T }
export async function loadJsonSource<T>(url: string): Promise<JsonSource<T>> {
  const res = await fetch(`${url}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`JSON fetch HTTP ${res.status}`);
  const source = await res.text();
  return { source, value: JSON.parse(source) as T };
}

// TSV slot → calcWeakness / recommend.js 가 쓰는 diff 이름.
export const SLOT_TO_DIFF_KEY: Record<string, string> = {
  DPN: 'NORMAL', DPH: 'HYPER', DPA: 'ANOTHER', DPL: 'LEGGENDARIA',
};

export interface WeaknessChart {
  title: string;
  diff: string;
  exScore: number;
  noteCount: number;
  scorePercent: number;
  lampNum: number;
}

// SongRow[] → calcWeakness charts (DP slot 만, noteCount > 0 인 차트).
//   calcWeakness 는 DP 패턴만 분석한다 (patterns-all-slim 의 chart key 가 DP_NOR/DP_HYP/DP_ANO/DP_LEG).
//   SP 데이터를 vec 계산 input 으로 넣으면 안 됨 — 항상 DP slot 만 추출.
export function rowsToWeaknessCharts(rows: SongRow[]): WeaknessChart[] {
  const out: WeaknessChart[] = [];
  for (const r of rows) {
    for (const slot of ['DPN', 'DPH', 'DPA', 'DPL'] as ChartSlot[]) {
      const c = r.charts[slot];
      if (!c) continue;
      const diff = SLOT_TO_DIFF_KEY[slot];
      if (!diff) continue;
      if (!c.noteCount || c.noteCount <= 0) continue;
      out.push({
        title: r.title, diff,
        exScore: c.exScore || 0,
        noteCount: c.noteCount,
        scorePercent: ((c.exScore || 0) / (c.noteCount * 2)) * 100,
        lampNum: LAMP_TO_NUM[c.lamp] ?? 0,
      });
    }
  }
  return out;
}
