// ohSorry 의 추천곡 로직 — INFOhSorry 용 포팅
//
// 원본: ohSorry/modules/calcOhsorryCore.js 의 buildRecs / buildPools / buildExhRecs (v3.3.5).
//
// 알고리즘 요약:
//   1. 카테고리 × 분류로 6 버킷 분리
//      - 카테고리: underLamp (stage 미클리어) / reached (stage 깼지만 DJ Level 미달)
//      - 분류: hard / easy / cleanup — baseStar 와 diffValue (★) 거리 기준
//   2. 카테고리별 sample 15곡 (클리어 인구수 desc top 10 + 랜덤 5)
//   3. 6 SLOT 으로 picked 10곡 추출:
//      under.hard 1 + reach.hard 1 / under.easy 2 + reach.easy 2 / under.cleanup 2 + reach.cleanup 2
//      각 SLOT 부족 시 같은 분류의 반대 카테고리에서 fallback, 그래도 부족하면 전체 풀에서 보충
//   4. EXH 는 별도 buildExhRecs — EXH ★ 낮은 30곡 → rate(=exScore/(noteCount*2)) desc 10곡
//   5. recLevelMode='lv12' 시 gameLevel===12 만 풀에 포함 (baseStar≥6 default)
//
// 매번 random shuffle 이라 호출할 때마다 결과 바뀜 ("다시 뽑기" 효과).
import type { ChartSlot, Lamp } from './types';

// 추천곡의 input — ohSorryRating.json 등재곡만 풀에 포함.
//
// 내부 추천 평가용 (level / ec / hc / exh) = ohSorryRating estimates 사용
//   level = zasaLevel, ec = estEc, hc = estHc, exh = estExh
// 표시용 (displayEc / displayHc / displayExh / displayLevel) = ereter 실측 우선, 없으면 estimates 로 fallback
// ereter 실측 (ereterEc / ereterHc / ereterExh) = oldOSR fitData 빌더에서 사용
export interface RecInputChart {
  title: string;
  slot: ChartSlot;
  diff: string; // 'NORMAL' / 'HYPER' / 'ANOTHER' / 'LEGGENDARIA'
  // 내부 추천 평가용 — ohSorryRating estimates (모든 풀곡에 채워짐)
  level: number; // zasaLevel
  ec: number | null; // estEc
  hc: number | null; // estHc
  exh: number | null; // estExh
  ec_n: number | null; // nEcCleared (인구수, 정렬용)
  hc_n: number | null; // nHcCleared
  exh_n: number | null; // estimates 에는 보통 없음 → 0
  // 사용자 플레이 정보
  lamp: Lamp;
  lampNum: number;
  djLevel: string | null; // DJ Level (AAA/AA/A/B/C/D/E/F)
  missCount: number | null; // BP — Reflux tracker.tsv
  // ereter 실측 — 있을 때만 채움. oldOSR fitData / 일부 표시 용.
  ereterLevel: number | null;
  ereterEc: number | null;
  ereterHc: number | null;
  ereterExh: number | null;
  ereterEcN: number | null;
  ereterHcN: number | null;
  ereterExhN: number | null;
  // 메타
  gameLevel?: number | null; // INF 게임 lv (11 / 12)
  zasaLevel?: number | null; // zasa★ (10.2~12.7)
  isRatingFallback?: boolean; // true: ereter 미등재 (UI 색 구분 / 추정값 표시 fallback)
  // Reflux TSV 추가 정보 (supabase 업로드용)
  unlocked?: boolean;
  exScore?: number | null;
  noteCount?: number | null;
  djPoints?: number | null;
  songType?: string | null;
  songLabel?: string | null;
}

export interface RecCandidate {
  title: string;
  slot: ChartSlot;
  diff: string;
  // 내부 알고리즘 평가용 — ratingMap estimates (level=zasaLevel, ec/hc/exh=estEc/Hc/Exh)
  level: number;
  currentLamp: Lamp;
  missCount: number | null;
  ec: number | null;
  hc: number | null;
  exh: number | null;
  ec_n: number | null;
  hc_n: number | null;
  exh_n: number | null;
  diffValue: number; // 해당 stage 의 ★ (알고리즘용 — ratingMap estimates)
  diffCount: number; // 해당 stage 의 클리어 인구수 (정렬용)
  margin: number; // baseStar - diffValue (음수면 도전, 양수면 정리)
  category: 'challenge-hard' | 'challenge-easy' | 'cleanup' | 'exh-near';
  // 표시용 — ereter 실측 (있으면 UI 에서 우선 표시)
  ereterLevel: number | null;
  ereterEc: number | null;
  ereterHc: number | null;
  ereterExh: number | null;
  ereterEcN: number | null;
  ereterHcN: number | null;
  ereterExhN: number | null;
  gameLevel?: number | null; // INF 게임 lv (11 / 12).
  isRatingFallback?: boolean; // true 면 UI 색 구분 (ratingMap 추정 / 미매칭). ereter 매칭 곡은 false/undefined.
  // ohSorry 의 reached 카테고리 여부 — stage 는 깼지만 DJ Level 미달 (예: HC 깼는데 AA 미달).
  // refreshRecs 에서 제거 조건이 달라짐 (DJ Level 통과 시 제거).
  reached?: boolean;
  // EXH 전용 — exScore / (noteCount*2). refreshRecs 의 EXH 정렬 / "거의 통과" 표시용.
  rate?: number | null;
  // 사용자 플레이 메타 — refreshRecs 가 EXH rate 재계산에 사용.
  exScore?: number | null;
  noteCount?: number | null;
  djLevel?: string | null;
  lampNum?: number;
}

export type RecStage = 'ec' | 'hc' | 'exh';
export type RecLevelMode = 'all' | 'lv12';
export const STAGE_THRESHOLD: Record<RecStage, number> = { ec: 3, hc: 5, exh: 6 };

// stage 별 "DJ Level 미달이면 reached 풀에 들어갈 lamp" — 해당 stage 깬 곡 중 추가 클리어 단계 미진입
export function isReachedLamp(stage: RecStage, lampNum: number): boolean {
  if (stage === 'exh') return lampNum >= 6;     // EXH/FC/PFC
  if (stage === 'hc') return lampNum === 5;     // HC (EXH 이상은 EXH stage 에서 처리)
  return lampNum === 3 || lampNum === 4;        // EC/NC (EC stage)
}

// stage 별 DJ Level 통과 조건 — 도달 시 추천 풀에서 제외 (개선 여지 없음)
export function isAccuracyOK(stage: RecStage, djLevel: string | null | undefined): boolean {
  if (djLevel == null) return false;
  if (stage === 'exh') return djLevel === 'AAA';
  if (stage === 'hc') return djLevel === 'AAA' || djLevel === 'AA';
  return djLevel === 'AAA' || djLevel === 'AA' || djLevel === 'A';
}

// 도전곡 최대 offset — baseStar 위로 얼마까지 도전곡 풀에 포함할지.
// 저레벨 (★0.5) 사용자는 +1.0 까지, 고레벨 (★14.0) 사용자는 +0.3 까지. 사이는 선형 보간.
// 범위 밖은 clamp.
export function challengeOffset(baseStar: number): number {
  if (baseStar <= 0.5) return 1.0;
  if (baseStar >= 14.0) return 0.3;
  return 1.0 - ((baseStar - 0.5) * 0.7) / 13.5;
}

// 풀 범위 — stage 별로 다름.
//   HC / EXH (기본):
//     easy  = [base,            base + 0.2]                  (폭 0.2, base 위)
//     hard  = [base + offset - 0.3, base + offset]           (폭 0.3, offset top)
//     cleanup = [0, base)                                    (if-else 순서로 자동)
//   EC (살짝 아래로 시프트):
//     easy  = [base - 0.1,      base + 0.1]                  (폭 0.2, base 중심)
//     hard  = [base + offset - 0.4, base + offset - 0.1]     (폭 0.3, offset 보다 0.1 아래)
//     cleanup = [0, base - 0.1)                              (if-else 순서로 자동)
function poolBounds(
  baseStar: number,
  offset: number,
  stage: RecStage,
): { hardMin: number; hardMax: number; easyMin: number; easyMax: number } {
  if (stage === 'ec') {
    return {
      hardMin: baseStar + offset - 0.4,
      hardMax: baseStar + offset - 0.1,
      easyMin: baseStar - 0.1,
      easyMax: baseStar + 0.1,
    };
  }
  return {
    hardMin: baseStar + offset - 0.3,
    hardMax: baseStar + offset,
    easyMin: baseStar,
    easyMax: baseStar + 0.2,
  };
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function keyOf(r: { title: string; slot: ChartSlot }): string {
  return r.title + '|' + r.slot;
}

type ClassKey = 'hard' | 'easy' | 'cleanup';
type Bucket = Record<ClassKey, RecCandidate[]>;
const emptyBucket = (): Bucket => ({ hard: [], easy: [], cleanup: [] });

const CATEGORY_OF: Record<ClassKey, RecCandidate['category']> = {
  hard: 'challenge-hard',
  easy: 'challenge-easy',
  cleanup: 'cleanup',
};

function classify(
  dv: number,
  hcEstimate: number | null,
  baseStar: number,
  bounds: { hardMin: number; hardMax: number; easyMin: number; easyMax: number },
  stage: RecStage,
): ClassKey | null {
  const { hardMin, hardMax, easyMin, easyMax } = bounds;
  if (dv >= hardMin && dv <= hardMax && dv > easyMax) return 'hard';
  if (dv >= easyMin && dv <= easyMax) return 'easy';
  if (dv < baseStar) {
    // EC 정리곡: 하드클 추정값이 baseStar - 3 미만이면 너무 쉬워서 제외 (시간 낭비 방지)
    if (stage === 'ec' && typeof hcEstimate === 'number' && hcEstimate < baseStar - 3) return null;
    return 'cleanup';
  }
  return null;
}

// 6 버킷 빌더 — underLamp / reached × hard / easy / cleanup.
//
// 추천 후보 조건:
//   - under (lampNum < threshold)  → 해당 stage 미클리어. 무조건 후보.
//   - reached (isReachedLamp + !isAccuracyOK) → stage 는 깼지만 DJ Level 미달. 정확도 개선 여지.
//   - 그 외 (더 강한 lamp & 미reached, 또는 reached + DJ 통과) → 제외.
//   - reached + exScore===0 → dirty data (lamp 있는데 점수 0). 제외.
function buildPoolsBuckets(
  matched: RecInputChart[],
  baseStar: number,
  stage: RecStage,
  recLevelMode: RecLevelMode,
): { underLamp: Bucket; reached: Bucket } {
  const underLamp = emptyBucket();
  const reached = emptyBucket();
  if (!Number.isFinite(baseStar)) return { underLamp, reached };
  const threshold = STAGE_THRESHOLD[stage];
  const offset = challengeOffset(baseStar);
  const bounds = poolBounds(baseStar, offset, stage);
  const countField = (stage + '_n') as 'ec_n' | 'hc_n' | 'exh_n';

  for (const c of matched) {
    if (recLevelMode === 'lv12' && c.gameLevel !== 12) continue;
    const under = c.lampNum < threshold;
    const reachedForDj = isReachedLamp(stage, c.lampNum);
    if (!under && !reachedForDj) continue;
    if (reachedForDj && isAccuracyOK(stage, c.djLevel)) continue;
    if (reachedForDj && c.exScore === 0) continue;

    const dv = c[stage];
    if (typeof dv !== 'number') continue;
    const cls = classify(dv, c.hc, baseStar, bounds, stage);
    if (cls == null) continue;
    const dn = c[countField];

    const item: RecCandidate = {
      title: c.title,
      slot: c.slot,
      diff: c.diff,
      level: c.level,
      currentLamp: c.lamp,
      missCount: c.missCount,
      ec: c.ec,
      hc: c.hc,
      exh: c.exh,
      ec_n: c.ec_n,
      hc_n: c.hc_n,
      exh_n: c.exh_n,
      diffValue: dv,
      diffCount: typeof dn === 'number' ? dn : 0,
      margin: baseStar - dv,
      category: CATEGORY_OF[cls],
      ereterLevel: c.ereterLevel,
      ereterEc: c.ereterEc,
      ereterHc: c.ereterHc,
      ereterExh: c.ereterExh,
      ereterEcN: c.ereterEcN,
      ereterHcN: c.ereterHcN,
      ereterExhN: c.ereterExhN,
      gameLevel: c.gameLevel ?? null,
      isRatingFallback: c.isRatingFallback ?? false,
      reached: reachedForDj,
      djLevel: c.djLevel,
      lampNum: c.lampNum,
      exScore: c.exScore ?? null,
      noteCount: c.noteCount ?? null,
    };
    (reachedForDj ? reached : underLamp)[cls].push(item);
  }
  return { underLamp, reached };
}

// 카테고리 내 sample 15곡 = 클리어 인구수 desc top 10 + 그 외 무작위 5.
function sample15(cat: Bucket, countField: 'ec_n' | 'hc_n' | 'exh_n'): RecCandidate[] {
  const pool = [...cat.hard, ...cat.easy, ...cat.cleanup];
  const sorted = [...pool].sort((a, b) => (b[countField] ?? 0) - (a[countField] ?? 0));
  const top10 = sorted.slice(0, 10);
  const usedKeys = new Set(top10.map(keyOf));
  const rest = pool.filter((r) => !usedKeys.has(keyOf(r)));
  const rand5 = shuffle(rest).slice(0, 5);
  return [...top10, ...rand5];
}

// sample 안에서 다시 분류 (hard / easy / cleanup) 별로 그룹핑.
function regroup(sample: RecCandidate[], cat: Bucket): Bucket {
  const out = emptyBucket();
  const tag = new Map<string, ClassKey>();
  (['hard', 'easy', 'cleanup'] as const).forEach((cls) =>
    cat[cls].forEach((r) => tag.set(keyOf(r), cls)),
  );
  for (const r of sample) {
    const cls = tag.get(keyOf(r));
    if (cls) out[cls].push(r);
  }
  return out;
}

// 6 SLOT 추출 — under.hard 1 + reach.hard 1 / under.easy 2 + reach.easy 2 / under.cleanup 2 + reach.cleanup 2.
// 각 SLOT 부족 시 같은 분류의 반대 카테고리에서 fallback.
export function buildRecsWithPool(
  matched: RecInputChart[],
  baseStar: number,
  stage: RecStage,
  recLevelMode: RecLevelMode = 'all',
): { picked: RecCandidate[]; pool: RecCandidate[] } {
  if (!Number.isFinite(baseStar)) return { picked: [], pool: [] };
  const { underLamp, reached } = buildPoolsBuckets(matched, baseStar, stage, recLevelMode);
  const countField = (stage + '_n') as 'ec_n' | 'hc_n' | 'exh_n';

  const underSample = sample15(underLamp, countField);
  const reachedSample = sample15(reached, countField);
  const under = regroup(underSample, underLamp);
  const reach = regroup(reachedSample, reached);

  const SLOTS: { primary: RecCandidate[]; fallback: RecCandidate[]; n: number }[] = [
    { primary: under.hard,    fallback: reach.hard,    n: 1 },
    { primary: reach.hard,    fallback: under.hard,    n: 1 },
    { primary: under.easy,    fallback: reach.easy,    n: 2 },
    { primary: reach.easy,    fallback: under.easy,    n: 2 },
    { primary: under.cleanup, fallback: reach.cleanup, n: 2 },
    { primary: reach.cleanup, fallback: under.cleanup, n: 2 },
  ];

  const used = new Set<string>();
  const picks: RecCandidate[] = [];
  for (const s of SLOTS) {
    const avail1 = shuffle(s.primary).filter((r) => !used.has(keyOf(r)));
    const taken1 = avail1.slice(0, s.n);
    for (const r of taken1) used.add(keyOf(r));
    picks.push(...taken1);
    const short = s.n - taken1.length;
    if (short > 0) {
      const avail2 = shuffle(s.fallback).filter((r) => !used.has(keyOf(r)));
      const taken2 = avail2.slice(0, short);
      for (const r of taken2) used.add(keyOf(r));
      picks.push(...taken2);
    }
  }

  // 분류 fallback 모두 실패해도 합계가 부족하면 전체 풀 (분류 무관) 에서 마지막 보충
  const allCands = [...underSample, ...reachedSample];
  const need = 10 - picks.length;
  if (need > 0) {
    const rest = allCands.filter((r) => !used.has(keyOf(r)));
    const taken = shuffle(rest).slice(0, need);
    for (const r of taken) used.add(keyOf(r));
    picks.push(...taken);
  }

  // 표시 순서: 카테고리 무관, 전체 10곡 ★ asc 통합 정렬
  const picked = picks.sort((a, b) => a.diffValue - b.diffValue);
  // pool = 후보 합집합 - picked (보충용)
  const pool = allCands.filter((r) => !used.has(keyOf(r)));
  return { picked, pool };
}

// 호환용 — picked 만 반환
export function buildRecs(
  matched: RecInputChart[],
  baseStar: number,
  stage: RecStage,
  recLevelMode: RecLevelMode = 'all',
): RecCandidate[] {
  return buildRecsWithPool(matched, baseStar, stage, recLevelMode).picked;
}

// EXH 전용 추천 — ohSorry 의 buildExhRecs 포팅.
//   조건:
//     1. recLevelMode='lv12' 시 gameLevel===12 만
//     2. lampNum >= 6 && djLevel === 'AAA' → 제외 (AAA 도달)
//     3. lampNum >= 6 && exScore === 0 → 제외 (dirty data)
//     4. 11.6 ≤ level ≤ 12.7 만 (zasaLevel 범위)
//     5. exh 추정값 baseStar-2 ≤ exh ≤ baseStar+1
//   정렬:
//     a. EXH ★ asc → top 30 (가장 쉬운 30곡)
//     b. rate = exScore / (noteCount*2) desc (null 은 뒤로) → top 10 ("거의 통과한 곡" 우선)
export function buildExhRecs(
  matched: RecInputChart[],
  baseStar: number,
  recLevelMode: RecLevelMode = 'all',
): { picked: RecCandidate[]; pool: RecCandidate[] } {
  if (!Number.isFinite(baseStar)) return { picked: [], pool: [] };
  const candidates: RecCandidate[] = [];
  for (const c of matched) {
    if (recLevelMode === 'lv12' && c.gameLevel !== 12) continue;
    if (c.lampNum >= 6 && c.djLevel === 'AAA') continue;
    if (c.lampNum >= 6 && c.exScore === 0) continue;
    if (c.level < 11.6 || c.level > 12.7) continue;
    if (typeof c.exh !== 'number') continue;
    if (c.exh > baseStar + 1) continue;
    if (c.exh < baseStar - 2) continue;

    const rate =
      typeof c.exScore === 'number' && typeof c.noteCount === 'number' && c.noteCount > 0
        ? c.exScore / (c.noteCount * 2)
        : null;
    candidates.push({
      title: c.title,
      slot: c.slot,
      diff: c.diff,
      level: c.level,
      currentLamp: c.lamp,
      missCount: c.missCount,
      ec: c.ec,
      hc: c.hc,
      exh: c.exh,
      ec_n: c.ec_n,
      hc_n: c.hc_n,
      exh_n: c.exh_n,
      diffValue: c.exh,
      diffCount: typeof c.exh_n === 'number' ? c.exh_n : 0,
      margin: baseStar - c.exh,
      category: 'exh-near',
      ereterLevel: c.ereterLevel,
      ereterEc: c.ereterEc,
      ereterHc: c.ereterHc,
      ereterExh: c.ereterExh,
      ereterEcN: c.ereterEcN,
      ereterHcN: c.ereterHcN,
      ereterExhN: c.ereterExhN,
      gameLevel: c.gameLevel ?? null,
      isRatingFallback: c.isRatingFallback ?? false,
      rate,
      exScore: c.exScore ?? null,
      noteCount: c.noteCount ?? null,
      djLevel: c.djLevel,
      lampNum: c.lampNum,
    });
  }
  // 1. EXH ★ 낮은 순 → top 30
  candidates.sort((a, b) => a.diffValue - b.diffValue);
  const top30 = candidates.slice(0, 30);
  // 2. rate desc (null 뒤로)
  top30.sort((a, b) => compareRateDesc(a.rate, b.rate));
  return { picked: top30.slice(0, 10), pool: top30.slice(10) };
}

// EXH 정렬 비교 — rate desc, null 은 뒤로. App.tsx 의 refreshRecs 와 buildExhRecs 가 공유.
export function compareRateDesc(ra: number | null | undefined, rb: number | null | undefined): number {
  if (ra == null && rb == null) return 0;
  if (ra == null) return 1;
  if (rb == null) return -1;
  return rb - ra;
}

// stage 별 picked / pool 에서 제거할 조건:
//   - 더 강한 lamp 까지 클리어 (under 도 아니고 reached 도 아닌 lamp) → 제거
//   - reached + DJ Level 통과 → 제거 (개선 여지 없음)
export function shouldDropFromRecs(
  stage: RecStage,
  lampNum: number,
  djLevel: string | null | undefined,
): boolean {
  const threshold = STAGE_THRESHOLD[stage];
  const under = lampNum < threshold;
  const reachedForDj = isReachedLamp(stage, lampNum);
  if (!under && !reachedForDj) return true;
  if (reachedForDj && isAccuracyOK(stage, djLevel)) return true;
  return false;
}
