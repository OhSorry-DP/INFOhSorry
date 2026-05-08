// INFINITAS (Reflux) 차트 ↔ ereter ★ 차트 매칭
//
// ohSorry 의 norm() 그대로 사용: 곡명을 NFKC 정규화 + 공백/괄호/기호 통일.
// 매칭 키 = norm(title) + '|' + diff
// INFINITAS 의 slot (SPN/DPN/...) 을 ereter 의 diff 명 (NORMAL/HYPER/...) 으로 변환.
import type { ChartSlot, EreterChart, SongChart } from './types';

export function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[~∼〜～]/g, '~')
    .replace(/[!！]/g, '!')
    .replace(/[?？]/g, '?')
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')')
    .normalize('NFKC');
}

const SLOT_TO_DIFF: Record<ChartSlot, string> = {
  SPB: 'BEGINNER',
  SPN: 'NORMAL',
  SPH: 'HYPER',
  SPA: 'ANOTHER',
  SPL: 'LEGGENDARIA',
  DPN: 'NORMAL',
  DPH: 'HYPER',
  DPA: 'ANOTHER',
  DPL: 'LEGGENDARIA',
};

export function slotToDiff(slot: ChartSlot): string {
  return SLOT_TO_DIFF[slot];
}

// ereter charts 를 (norm(title) + '|' + diff) → chart 인덱스로
//
// 충돌 검사: norm 결과가 같은 다른 곡 (있으면 안 되지만 안전을 위해 검증). 발생 시
// 마지막 entry 가 이전을 덮어씀 + console.warn 으로 보고.
export function buildEreterIndex(charts: EreterChart[]): {
  index: Map<string, EreterChart>;
  collisions: Array<{ key: string; titles: string[] }>;
} {
  const m = new Map<string, EreterChart>();
  const collisionTitles = new Map<string, Set<string>>();
  for (const c of charts) {
    if (!c.title || !c.diff) continue;
    const key = norm(c.title) + '|' + c.diff;
    const existing = m.get(key);
    if (existing && existing.title !== c.title) {
      // 충돌 — norm 후 같은 키지만 원본 title 이 다름
      const set = collisionTitles.get(key) ?? new Set<string>();
      set.add(existing.title);
      set.add(c.title);
      collisionTitles.set(key, set);
    }
    m.set(key, c);
  }
  const collisions = Array.from(collisionTitles.entries()).map(([key, set]) => ({
    key,
    titles: Array.from(set),
  }));
  if (collisions.length > 0) {
    console.warn(`[match] ereter index 에서 norm 충돌 ${collisions.length}건:`);
    for (const col of collisions) {
      console.warn(`  ${col.key}: ${col.titles.join(' / ')}`);
    }
  }
  return { index: m, collisions };
}

export function matchEreter(
  inf: SongChart,
  ereterIdx: Map<string, EreterChart>,
): EreterChart | undefined {
  const diff = SLOT_TO_DIFF[inf.slot];
  if (!diff) return undefined;
  return ereterIdx.get(norm(inf.title) + '|' + diff);
}

// Reflux Lamp string → ohSorry numeric lamp
//   NP=0 / Failed=1 / Assist=2 / Easy=3 / Clear=4 / Hard=5 / ExHard=6 / FullCombo=7
export const LAMP_TO_NUM: Record<string, number> = {
  NP: 0,
  Failed: 1,
  Assist: 2,
  Easy: 3,
  Clear: 4,
  Hard: 5,
  ExHard: 6,
  FullCombo: 7,
};

export function lampNum(lamp: string): number {
  return LAMP_TO_NUM[lamp] ?? 0;
}
