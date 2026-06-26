// variants.ts — 변종(동일 곡명+diff 인데 AC 재수록 ≠ INF/구 채보) 10곡 표시 분기용 상수.
//
// 정본: ohSorryAdmin/variant-map.json (10곡 고정 목록이라 작은 상수로 번들).
//
// INFINITAS 는 변종의 INF/구 채보(★ 낮음)를 쓰는데 ohSorryRating ratings 는 현행 AC 채보(★11/12)만
//   수록한다 → norm(title)|diff 조인 시 AC rating/zasa 가 유저의 INF 채보(★7~9)에 잘못 붙는다.
//   이 set 으로 변종 곡만 가드해서, in-game level 이 다르면(=INF 채보) AC 값을 물지 않게 한다.
//   비변종 곡은 영향 0, 같은 레벨 변종(예 DP ANOTHER 동급)·AC 채보는 정상 부착.
import { norm } from './match';

const VARIANT_TITLES = [
  "L'amour et la liberté",
  'VJ ARMY', 'MAX 300', 'ADVANCE', 'PARANOIA survivor MAX', 'DEEP ROAR', 'madrugada',
  'THE SHINING POLARIS (kors k mix)', 'ミッドナイト堕天使', 'New Castle Legions',
];

export const VARIANT_NORM_TITLES: ReadonlySet<string> = new Set(VARIANT_TITLES.map((t) => norm(t)));

// 이 곡이 변종(AC≠INF 다중 채보) 대상인가.
export function isVariantTitle(title: string): boolean {
  return VARIANT_NORM_TITLES.has(norm(title));
}
