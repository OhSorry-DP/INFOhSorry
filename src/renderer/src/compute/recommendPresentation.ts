import type { ChartSlot } from '../../../shared/types';
import { compareRateDesc, shouldDropFromRecs } from '../../../shared/recommend';
import type { RecCandidate, RecStage, RecDjMode, RecInputChart } from '../../../shared/recommend';
type CardStage = RecStage | 'weakness';
type RecState = { picked: RecCandidate[]; pool: RecCandidate[] };
const CORE_DIFF_TO_SLOT: Record<string, ChartSlot> = {
  NORMAL: 'DPN', HYPER: 'DPH', ANOTHER: 'DPA', LEGGENDARIA: 'DPL',
};
const CORE_LAMP_FULL_TO_ABBR: Record<string, string> = {
  'NO PLAY': 'NP', 'FAILED': 'F', 'ASSIST': 'AC', 'EASY': 'EC',
  'CLEAR': 'NC', 'HARD': 'HC', 'EX HARD': 'EX', 'FULL COMBO': 'FC',
};
const CORE_CAT_MAP: Record<string, RecCandidate['category']> = {
  cleanup: 'cleanup', easy: 'challenge-easy', hard: 'challenge-hard',
};
export function recRowToCandidate(r: any, stage: CardStage): RecCandidate {
  const slot = CORE_DIFF_TO_SLOT[r.chart] || 'DPA';
  const lampFull = r.currentLamp || 'NO PLAY';
  const lampAbbr = CORE_LAMP_FULL_TO_ABBR[lampFull] || lampFull;
  const isWeak = stage === 'weakness';
  const cat: RecCandidate['category'] = isWeak ? 'cleanup' : (CORE_CAT_MAP[r._category as string] || 'cleanup');
  const countField = stage === 'weakness' ? 'ec_n' : stage + '_n';
  return {
    cardHashtags: r._cardHashtags, cardBestLabel: r._cardBestLabel,
    title: r.title, slot, diff: r.chart, level: r.level,
    currentLamp: lampAbbr,
    missCount: typeof r.missCount === 'number' ? r.missCount : null,
    ec: r.ec ?? null, hc: r.hc ?? null, exh: r.exh ?? null,
    ec_n: r.ec_n ?? null, hc_n: r.hc_n ?? null, exh_n: r.exh_n ?? null,
    diffValue: r.diffValue,
    diffCount: r[countField] ?? 0,
    margin: r.margin ?? 0,
    category: cat,
    ereterLevel: null, ereterEc: null, ereterHc: null, ereterExh: null,
    ereterEcN: null, ereterHcN: null, ereterExhN: null,
    gameLevel: r.gameLevel ?? null,
    isRatingFallback: !!r.ratingOnly,
    rate: r.scoreRate ?? null,
    exScore: r.exScore ?? null,
    noteCount: r.noteCount ?? null,
    djLevel: r.djLevel ?? null,
    lampNum: r.lampNum,
    unlocked: true,
    // weakness 전용 필드 — buildWeaknessRecs 결과의 _* 필드.
    practiceType: isWeak ? r._practiceType : undefined,
    targetRate: isWeak ? r._targetRate : undefined,
    targetExScore: isWeak ? r._targetExScore : undefined,
    currentExScore: isWeak ? r._currentExScore : undefined,
    targetDjLevel: isWeak ? r._targetDjLevel : undefined,
    // 본체 hashtag / 배치 라벨 (모든 stage 공통).
    hashtags: Array.isArray(r._hashtags) ? r._hashtags : undefined,
    bestLabel: r._matchByHand?.bestLabel || undefined,
  };
}
export function refreshRecs(
    prev: RecState,
    stage: RecStage,
    charts: RecInputChart[],
    djMode: RecDjMode,
  ): RecState {
    const map = new Map<string, RecInputChart>();
    for (const c of charts) map.set(c.title + '|' + c.slot, c);
    // 갱신 정책 (ohSorry v3.3.5 reached 모델):
    //   - 제거: shouldDropFromRecs — 더 강한 lamp 까지 진입했거나 reached + DJ Level 통과
    //   - 갱신: lamp / missCount / djLevel / exScore / noteCount 변화 시 새 객체 (EXH 면 rate 재계산)
    //   - 변화 없으면 같은 ref 재사용 → React 재렌더 skip
    const updateCandidate = (r: RecCandidate, c: RecInputChart): RecCandidate | null => {
      const changed =
        c.lamp !== r.currentLamp ||
        c.missCount !== r.missCount ||
        c.djLevel !== r.djLevel ||
        c.exScore !== r.exScore ||
        c.noteCount !== r.noteCount ||
        c.lampNum !== r.lampNum;
      if (!changed) return null;
      const rate =
        stage === 'exh' && typeof c.exScore === 'number' && typeof c.noteCount === 'number' && c.noteCount > 0
          ? c.exScore / (c.noteCount * 2)
          : stage === 'exh'
          ? null
          : r.rate;
      return {
        ...r,
        currentLamp: c.lamp,
        missCount: c.missCount,
        djLevel: c.djLevel,
        exScore: c.exScore ?? null,
        noteCount: c.noteCount ?? null,
        lampNum: c.lampNum,
        rate,
      };
    };

    let droppedCount = 0;
    let pickedChanged = false;
    const updatedPicked: RecCandidate[] = [];
    for (const r of prev.picked) {
      const c = map.get(r.title + '|' + r.slot);
      if (c) {
        if (shouldDropFromRecs(stage, c.lampNum, c.djLevel, djMode)) {
          droppedCount++;
          pickedChanged = true;
          continue;
        }
        const next = updateCandidate(r, c);
        if (next) {
          updatedPicked.push(next);
          pickedChanged = true;
        } else {
          updatedPicked.push(r);
        }
      } else {
        updatedPicked.push(r);
      }
    }
    let poolChanged = false;
    const updatedPool: RecCandidate[] = [];
    for (const r of prev.pool) {
      const c = map.get(r.title + '|' + r.slot);
      if (c) {
        if (shouldDropFromRecs(stage, c.lampNum, c.djLevel, djMode)) {
          poolChanged = true;
          continue;
        }
        const next = updateCandidate(r, c);
        if (next) {
          updatedPool.push(next);
          poolChanged = true;
        } else {
          updatedPool.push(r);
        }
      } else {
        updatedPool.push(r);
      }
    }
    // 제거된 만큼 풀에서 보충
    while (droppedCount > 0 && updatedPool.length > 0) {
      const next = updatedPool.shift();
      if (next) updatedPicked.push(next);
      droppedCount--;
      poolChanged = true;
    }
    if (!pickedChanged && !poolChanged) return prev;
    // 변화 있을 때만 정렬:
    //   EC/HC — diffValue (★) asc
    //   EXH   — rate desc (null 뒤로) — buildExhRecs 와 동일한 순서 유지
    if (stage === 'exh') {
      updatedPicked.sort((a, b) => compareRateDesc(a.rate, b.rate));
    } else {
      updatedPicked.sort((a, b) => a.diffValue - b.diffValue);
    }
    return { picked: updatedPicked, pool: updatedPool };
  }
