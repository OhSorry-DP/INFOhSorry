// normTitle.js — 곡명 정규화 통합 모듈 (v0.0.5, UMD)
//
// BEMANI (IIDX) 곡명 매칭용 강한 norm.
//
// UMD — 브라우저와 Node 양쪽에서 동작:
//   - 브라우저: 오소리 본체 / 라이벌 wrapper 가 gist fetch + eval → window.OhsorryNorm
//   - Node:     ohSorryAdmin / ohSorryRating 스크립트가 require → module.exports
//
// !! 이 파일은 4곳에 동일 사본 — ohSorryRating / ohSorry / ohSorryAdmin / INFOhSorry.
//    마스터는 ohSorryRating/modules/normTitle.js (구조개편 §0 Phase1B, 2026-06-16 본체→레이팅).
//    INFOhSorry 는 src/shared/normTitle.js (match.ts 가 import, 타입은 옆 normTitle.d.ts).
//    수정 후 반드시
//      node ohSorryAdmin/scripts/syncNormTitle.js
//    로 나머지 3곳(ohSorry·ohSorryAdmin·INFOhSorry)에 복사할 것 (별개 repo 라 물리적 단일 파일은 불가).
//
// 인터페이스 — norm(s): 정규화 문자열 / denorm(k): NORM_OVERRIDES 키만 raw 복원
//
// 정규화 단계 (순서 중요):
//   0. TITLE_ALIASES — eagate raw → textage raw 치환 (한자 변형 등, norm 불가능 케이스)
//   1. NORM_OVERRIDES — 동명이곡 (norm 후 같은 키, raw 만 다른) 강제 분리 키
//   2. 대문자 Æ 처리 (eagate "ÆTHER" → "ATHER", lowercase 전)
//   3. lowercase
//   4. NFD + diacritic 제거 (그리스 악센트 έ → ε 등 base char 화)
//   5. 공백 제거 (ASCII + 전각 U+3000)
//   6. 변종 기호 → ASCII (틸드/괄호/물음표/느낌표/¡¿/쿼터/대시)
//   7. 라틴 확장 → ASCII (ƒ Ø æ ə Œ ß)
//   8. 키릴 / 그리스 / 기타 homoglyph → ASCII (К→k, λ→l, ꓘ→k 등)
//   9. 장식/음악/수학 기호 제거 (♥ ★ † → ∞)
//  10. NFKC (전각 → 반각 호환 분해)
//
// raw 같은 동명이곡 (예: ADVANCE 295 vs 338) 은 norm 으로 구분 불가능 — dbConn 이
// songs.ac 비트맵 (1=AC, 2=INF, 3=둘다) + played_version 으로 필터링.
// ============================================================

// ── UMD wrapper — 브라우저(window.OhsorryNorm) / Node(module.exports) 양쪽 지원 ──
;(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;  // Node
  if (typeof window !== 'undefined') window.OhsorryNorm = api;             // 브라우저
})(function () {
  // eagate raw → textage raw 치환 (norm 으로는 절대 못 잡는 표기 차이)
  // 곡 추가 시 수동 보강.
  var TITLE_ALIASES = {
    '火影': '焱影',                          // eagate '火影' (raw) → textage '焱影' (raw)
    'FiZZλ_POT!0N': 'FiZZλ_PØT!OИ',          // eagate '0N' (raw) → textage 'ØИ' (raw)
    'FiZZλ_PØT!0И': 'FiZZλ_PØT!OИ',          // zasa '0И' (raw) → textage 'OИ' ('0' 숫자 → 'O' 알파벳)
    'Xlo': 'Xlø',                            // ereter 'Xlo' → textage 'Xlø' (Ø → O 알파벳 변형)
    'VOID': 'VØID',                          // ereter 'VOID' → textage 'VØID' (Ø → O 알파벳 변형)
    'CROSSROAD ～Left Story～': 'CROSSROAD',  // eagate 부제 표기 → songs 'CROSSROAD' (같은 곡)
    'Space Battleship S4TO': 'Space Battleship S4TØ',  // eagate '일반 O' → textage 'Ø' (U+00D8) — 'Ø' 가 norm 에서 '0' 으로 바뀌어 'O' 와 매칭 실패
    'メテオラ-meteor-': 'メテオラ -meteor-',  // eagate Reflux 공백 없는 표기 → textage 공백 있는 표기 (안전망 — norm 공백제거가 이미 처리하지만 cache stale 케이스 대응)
    'Lagrangian Point ?': 'Lagrangian Point Ø',  // eagate/Reflux 가 'Ø'(U+00D8)를 '?'로 인코딩 깨짐 → textage 'Ø' 로 복원 (norm 에서 Ø→0)
    'Lagrangian Point 0': 'Lagrangian Point Ø',  // 일부 소스가 'Ø'를 숫자 '0' 으로 표기 → textage 'Ø' 로 통일 (norm 결과는 동일하나 명시)
  };

  // 동명이곡 (norm 후 같은 키, raw 만 다른) → 강제 norm 키 분리.
  // 신곡 / 리메이크 쪽에 '2' suffix 부여 (관례).
  // raw same 동명이곡 (raw 까지 동일, 옛 AC vs INF) 은 여기서 처리 불가 — dbConn 의 ac flag 매칭.
  var NORM_OVERRIDES = {
    'ZEИITH':         'zenith2',         // vs 'Zenith' (1564) — EPOLIS 가 2
    'Shooting Star':  'shootingstar2',   // vs 'SHOOTING STAR' (369) — BLAZE LOTUS 가 2
    'With You':       'withyou2',        // vs 'with you…' (496) — EPOLIS 가 2
    'take me higher': 'takemehigher2',   // vs 'Take Me Higher' (771) — BISTROVER 가 2
  };

  // NORM_OVERRIDES reverse — denorm 용
  var NORM_OVERRIDES_REVERSE = {};
  for (var rawKey in NORM_OVERRIDES) {
    if (Object.prototype.hasOwnProperty.call(NORM_OVERRIDES, rawKey)) {
      NORM_OVERRIDES_REVERSE[NORM_OVERRIDES[rawKey]] = rawKey;
    }
  }

  function basicNorm(s) {
    return s
      // 대문자 Æ 는 lowercase 전에 — eagate "ÆTHER" → "ATHER" (Æ → A)
      .replace(/Æ/g, 'A')
      .toLowerCase()
      // NFD + diacritic 제거를 매핑 전에 (그리스 악센트 모음 έ → ε 등 base char 화)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      // 공백 제거
      .replace(/[\s　]+/g, '')
      // 틸드 변종
      .replace(/[~∼〜～]/g, '~')
      .replace(/[!！¡]/g, '!')      // ¡ (U+00A1 inverted) — "¡Viva!"
      .replace(/[?？¿]/g, '?')      // ¿ (U+00BF inverted)
      .replace(/[(（]/g, '(')
      .replace(/[)）]/g, ')')
      // 더블 쿼터 변종
      .replace(/[“”„‟〝〞〟]/g, '"')
      // 싱글 쿼터 변종
      .replace(/[‘’‚‛`´ʼˈˊˋ]/g, "'")
      // 라틴 확장
      .replace(/ƒ/g, 'f')
      .replace(/[Øø]/g, '0')        // eagate "ACTØ" → "ACT0", "VØID" → "V0ID"
      .replace(/æ/g, 'ae')          // eagate "Iræ" → "Irae"
      .replace(/[əә]/g, 'e')        // ə (U+0259 라틴) ә (U+04D9 키릴) — "uən"
      .replace(/[Œœ]/g, 'oe')
      .replace(/ß/g, 'ss')
      .replace(/§/g, 'ss')          // eagate "BLOSSOM" ↔ textage/songs "BLO§OM" (§ U+00A7 = ss)
      // 키릴 homoglyph
      .replace(/[Ии]/g, 'n')
      .replace(/[Аа]/g, 'a')
      .replace(/[Ее]/g, 'e')
      .replace(/[Кк]/g, 'k')
      .replace(/[Мм]/g, 'm')
      .replace(/[Оо]/g, 'o')
      .replace(/[Рр]/g, 'p')
      .replace(/[Сс]/g, 'c')
      .replace(/[Тт]/g, 't')
      .replace(/[Хх]/g, 'x')
      // 그리스 → ASCII
      .replace(/[Ττ]/g, 't')
      .replace(/[Λλ]/g, 'l')
      .replace(/[Οο]/g, 'o')
      .replace(/[Εε]/g, 'e')
      .replace(/[Σσς]/g, 's')
      .replace(/[Αα]/g, 'a')
      .replace(/[Ρρ]/g, 'r')
      .replace(/[Ηη]/g, 'h')
      .replace(/[Ιι]/g, 'i')
      .replace(/[Υυ]/g, 'y')
      .replace(/[Νν]/g, 'n')
      .replace(/[Μμ]/g, 'm')
      .replace(/[Χχ]/g, 'x')
      // 기타 homoglyph
      .replace(/[ꓘꞰ꟰Ƙƙʞ]/g, 'k')    // K homoglyph: ꓘ Ʞ Ʇ Ƙ ƙ ʞ (소문자 ʞ U+029E)
      .replace(/[…・･.]/g, '')       // ellipsis / katakana middle dot / ASCII 마침표
      // 대시 변종 (가타카나 장음 U+30FC 제외)
      .replace(/[—–‐‑−]/g, '-')
      // 장식 / 음악 / 수학 기호 제거
      .replace(/[♠-♯]/g, '')
      .replace(/[†‡]/g, '')
      .replace(/[←-↓]/g, '')
      .replace(/[※⁂]/g, '')
      .replace(/[★☆]/g, '')
      .replace(/[∫∮∂∇∈∞]/g, '')
      // 최종 정규화 — 전각 → 반각 등
      .normalize('NFKC');
  }

  function norm(s) {
    var raw = String(s == null ? '' : s);
    // TITLE_ALIASES — raw 단계 치환
    if (Object.prototype.hasOwnProperty.call(TITLE_ALIASES, raw)) {
      raw = TITLE_ALIASES[raw];
    }
    // NORM_OVERRIDES — raw 가 override 키면 바로 강제 키 반환 (기본 norm 우회)
    if (Object.prototype.hasOwnProperty.call(NORM_OVERRIDES, raw)) {
      return NORM_OVERRIDES[raw];
    }
    return basicNorm(raw);
  }

  // denorm — NORM_OVERRIDES 적용된 norm 키 (예: 'zenith2') 만 raw 로 역복원.
  // 그 외 일반 norm 키 (lowercase 정보 손실) 는 그대로 반환 — 호출자가 raw 보존된 데이터 사용해야 함.
  function denorm(k) {
    if (k == null) return '';
    var key = String(k);
    if (Object.prototype.hasOwnProperty.call(NORM_OVERRIDES_REVERSE, key)) {
      return NORM_OVERRIDES_REVERSE[key];
    }
    return key;
  }

  return {
    VERSION: '0.0.6',
    norm: norm,
    denorm: denorm,
  };
});
