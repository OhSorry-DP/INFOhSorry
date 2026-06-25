// normTitle.js (UMD) 타입 선언 — 실제 코드는 동기 사본 normTitle.js (마스터: ohSorryRating/modules/normTitle.js).
//   tsc 가 .js 본체를 컴파일하지 않도록(allowJs 불필요, 바이트 동일 유지) 타입만 여기서 제공.
//   import 시 './normTitle' → 타입은 이 .d.ts, 런타임은 normTitle.js (번들러가 .js 해석).
declare const OhsorryNorm: {
  VERSION: string;
  /** BEMANI 곡명 강한 정규화 — 매칭 키 생성 */
  norm(s: string | null | undefined): string;
  /** NORM_OVERRIDES 적용 키만 raw 복원, 그 외엔 그대로 */
  denorm(k: string | null | undefined): string;
};
export default OhsorryNorm;
