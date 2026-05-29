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

// eagate raw → textage raw 치환 (norm 으로는 못 잡는 표기 차이)
const TITLE_ALIASES: Record<string, string> = {
  '火影': '焱影',                          // eagate '火影' → textage '焱影'
  'FiZZλ_POT!0N': 'FiZZλ_PØT!OИ',          // eagate '0N' → textage 'ØИ'
  'FiZZλ_PØT!0И': 'FiZZλ_PØT!OИ',          // zasa '0И' → textage 'OИ'
  'Xlo': 'Xlø',                            // ereter 'Xlo' → textage 'Xlø'
  'VOID': 'VØID',                          // ereter 'VOID' → textage 'VØID'
  // INF 메모리 dump 가 부제목까지 포함하지만 songs.title 은 본곡명만 — 매칭용 alias.
  'CROSSROAD ~Left Story~': 'CROSSROAD',
  'CROSSROAD ～Left Story～': 'CROSSROAD',  // full-width tilde 변종 (ohSorry normTitle v0.0.6 과 동기화)
  'Space Battleship S4TO': 'Space Battleship S4TØ',  // INF dump '일반 O' → textage 'Ø' (norm 의 Ø→0 변환 차이)
  'メテオラ-meteor-': 'メテオラ -meteor-',  // INF dump 공백 없는 표기 → textage 공백 있는 표기
};

// 동명이곡 (norm 후 같은 키, raw 만 다른) → 강제 norm 키 분리 (신곡 쪽에 '2' suffix)
const NORM_OVERRIDES: Record<string, string> = {
  'ZEИITH':         'zenith2',
  'Shooting Star':  'shootingstar2',
  'With You':       'withyou2',
  'take me higher': 'takemehigher2',
};

// NORM_OVERRIDES reverse — denorm 용
const NORM_OVERRIDES_REVERSE: Record<string, string> = {};
for (const rawKey of Object.keys(NORM_OVERRIDES)) {
  NORM_OVERRIDES_REVERSE[NORM_OVERRIDES[rawKey]] = rawKey;
}

function basicNorm(s: string): string {
  return s
    .replace(/Æ/g, 'A')          // 대문자 Æ — lowercase 전에 처리 (eagate "ÆTHER" → "ATHER")
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s　]+/g, '')
    .replace(/[~∼〜～]/g, '~')
    .replace(/[!！¡]/g, '!')
    .replace(/[?？¿]/g, '?')
    .replace(/[(（]/g, '(')
    .replace(/[)）]/g, ')')
    .replace(/[“”„‟〝〞〟]/g, '"')
    .replace(/[‘’‚‛`´ʼˈˊˋ]/g, "'")
    .replace(/ƒ/g, 'f')
    .replace(/[Øø]/g, '0')        // eagate Ø → 0 (숫자) — "ACTØ" → "ACT0"
    .replace(/æ/g, 'ae')          // "Iræ" → "irae"
    .replace(/[əә]/g, 'e')        // 라틴 + 키릴 schwa
    .replace(/[Œœ]/g, 'oe')
    .replace(/ß/g, 'ss')
    // 키릴 homoglyph
    .replace(/[Ии]/g, 'n').replace(/[Аа]/g, 'a').replace(/[Ее]/g, 'e').replace(/[Кк]/g, 'k')
    .replace(/[Мм]/g, 'm').replace(/[Оо]/g, 'o').replace(/[Рр]/g, 'p').replace(/[Сс]/g, 'c')
    .replace(/[Тт]/g, 't').replace(/[Хх]/g, 'x')
    // 그리스 → ASCII
    .replace(/[Ττ]/g, 't').replace(/[Λλ]/g, 'l').replace(/[Οο]/g, 'o').replace(/[Εε]/g, 'e')
    .replace(/[Σσς]/g, 's').replace(/[Αα]/g, 'a').replace(/[Ρρ]/g, 'r').replace(/[Ηη]/g, 'h')
    .replace(/[Ιι]/g, 'i').replace(/[Υυ]/g, 'y').replace(/[Νν]/g, 'n').replace(/[Μμ]/g, 'm')
    .replace(/[Χχ]/g, 'x')
    // K homoglyph
    .replace(/[ꓘꞰ꟰Ƙƙʞ]/g, 'k')
    .replace(/[…・･.]/g, '')       // ellipsis / katakana middle dot / period 제거
    .replace(/[—–‐‑−]/g, '-')
    .replace(/[♠-♯]/g, '').replace(/[†‡]/g, '').replace(/[←-↓]/g, '')
    .replace(/[※⁂]/g, '').replace(/[★☆]/g, '').replace(/[∫∮∂∇∈∞]/g, '')
    .normalize('NFKC');
}

export function norm(s: string): string {
  let raw = String(s == null ? '' : s);
  if (Object.prototype.hasOwnProperty.call(TITLE_ALIASES, raw)) raw = TITLE_ALIASES[raw];
  if (Object.prototype.hasOwnProperty.call(NORM_OVERRIDES, raw)) return NORM_OVERRIDES[raw];
  return basicNorm(raw);
}

// denorm — NORM_OVERRIDES 적용된 키만 raw 복원, 그 외엔 그대로
export function denorm(k: string | null | undefined): string {
  if (k == null) return '';
  const key = String(k);
  if (Object.prototype.hasOwnProperty.call(NORM_OVERRIDES_REVERSE, key)) return NORM_OVERRIDES_REVERSE[key];
  return key;
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
