// INFINITAS (Reflux) 차트 ↔ ereter ★ 차트 매칭 + 곡명 정규화 (v0.0.4 동기화)
//
// ohSorry / ohSorryAdmin / ohSorryRating 의 normTitle 과 동일한 강한 norm.
// 매칭 키 = norm(title) + '|' + diff
// INFINITAS 의 slot (SPN/DPN/...) 을 ereter 의 diff 명 (NORMAL/HYPER/...) 으로 변환.
//
// 정규화 단계 (순서 중요):
//   0. TITLE_ALIASES — eagate raw → textage raw 치환
//   1. NORM_OVERRIDES — 동명이곡 (norm 후 같은 키, raw 만 다른) 강제 분리
//   2. 대문자 Æ → A (lowercase 전)
//   3. lowercase / NFD diacritic / 공백 제거 / 기호 / 키릴 / 그리스 / 라틴확장 / NFKC
import type { ChartSlot, EreterChart, SongChart } from './types';
import OhsorryNorm from './normTitle';

// 곡명 정규화 — normTitle 마스터(ohSorryRating/modules/normTitle.js)의 동기 사본을 그대로 사용.
//   별칭(TITLE_ALIASES)·동명이곡(NORM_OVERRIDES)·basicNorm 은 전부 마스터 1곳에서 관리한다.
//   (예전엔 여기 손복제를 들고 있다 별칭이 어긋나 곡 중복이 났음 — 'Lagrangian Point ?' 전례.)
//   수정 후 반드시  node ohSorryAdmin/scripts/syncNormTitle.js  로 INFOhSorry 사본(normTitle.js)까지 갱신할 것.
export function norm(s: string | null | undefined): string {
  return OhsorryNorm.norm(s);
}

// denorm — NORM_OVERRIDES 적용된 키만 raw 복원, 그 외엔 그대로
export function denorm(k: string | null | undefined): string {
  return OhsorryNorm.denorm(k);
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

// Reflux Lamp enum string → ohSorry numeric lamp
//   NP=0 / F=1 (Failed) / AC=2 (Assist) / EC=3 (Easy) / NC=4 (Clear) /
//   HC=5 (Hard) / EX=6 (EX Hard) / FC=7 / PFC=7 (ohSorry 모델은 7 max — PFC 도 FC 로 통합)
export const LAMP_TO_NUM: Record<string, number> = {
  NP: 0,
  F: 1,
  AC: 2,
  EC: 3,
  NC: 4,
  HC: 5,
  EX: 6,
  FC: 7,
  PFC: 7,
};

export function lampNum(lamp: string): number {
  return LAMP_TO_NUM[lamp] ?? 0;
}
