// ProfileCard — DP12 RECOMMEND 상단에 표시되는 사용자 프로필 카드.
// ohSorry 의 e-amusement 프로필 카드 스타일 따라함 (DJ NAME / IIDX ID / ★).
// 프로필 데이터는 INFINITAS 메모리에서 직접 읽음 (useProfile).
import type { ProfileInfo } from './useProfile';
import type { StarResult } from '../../shared/star-estimator';

interface ProfileCardProps {
  profile: ProfileInfo;
  starResult: StarResult | null;
  // 두번째로 큰 scope 결과 (max 와의 차이 표시용). null 이면 "DP Recommend" 표시.
  secondHighest?: {
    name: 'primary' | 'ereter-only' | 'lv12-only' | 'all-11.6+';
    result: StarResult | null;
  } | null;
}

// scope 라벨 (한국어 표시)
const SCOPE_LABEL: Record<string, string> = {
  'ereter-only': '이레터넷만',
  'lv12-only': 'LEVEL 12 (이레터+추정)',
  'all-11.6+': '11.6+ 전체',
};

// 단위 색상 — 한자 / 한국식 / 일본식 모두 인식:
//   皆伝 / 개전 → 금빛
//   中伝 / 중전 → 은빛
//   1~8단 / 一~八段 → 파랑
//   9~10단 / 九~十段 → 빨강
//   X급 / X級 (kyu) → 회색
//   미취득 ("-") / 알 수 없음 → 회색
const KANJI_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
function rankClass(rank: string | null): string {
  if (!rank) return '';
  // 皆伝 / 개전 / 皆傳 — 'kaiden' (금)
  if (/皆伝|皆傳|개전/.test(rank)) return 'rank-kaiden';
  // 中伝 / 중전 — 'chuden' (은)
  if (/中伝|中傳|중전/.test(rank)) return 'rank-chuden';
  // X단 (Hangul / Arabic) 또는 X段 (Kanji)
  const dHangul = rank.match(/(\d{1,2})\s*단/);
  if (dHangul) {
    const n = parseInt(dHangul[1], 10);
    return n >= 9 ? 'rank-high' : 'rank-mid';
  }
  const dKanji = rank.match(/([一二三四五六七八九十]+)\s*段/);
  if (dKanji) {
    const s = dKanji[1];
    const n = s === '十' ? 10 : s.length === 1 && KANJI_NUM[s] ? KANJI_NUM[s] : null;
    if (n != null) return n >= 9 ? 'rank-high' : 'rank-mid';
  }
  // X급 / X級 — 회색
  if (/\d\s*[급級]/.test(rank)) return 'rank-low';
  return 'rank-low';
}

export function ProfileCard({
  profile,
  starResult,
  secondHighest,
}: ProfileCardProps): JSX.Element | null {
  const { djName, iidxId, iidxIdFormatted } = profile;

  // 메모리 read 가 한 번도 성공 X (게임 로그인 전 등) → 카드 자체 숨김
  if (!djName && !iidxId && !starResult) return null;

  // 2nd 표시: max (starResult.star) 와의 차이
  const secondNote = (() => {
    if (!starResult || !secondHighest || !secondHighest.result) return null;
    const diff = secondHighest.result.star - starResult.star;
    const diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2);
    const label = SCOPE_LABEL[secondHighest.name] || secondHighest.name;
    return { value: secondHighest.result.star, diffStr, label };
  })();

  return (
    <div className="profile-card">
      <div className="profile-card-info">
        <div className="profile-card-name-line">
          <span className="profile-card-name">{djName || '(DJ NAME 미확인)'}</span>
        </div>
        {iidxId && <div className="profile-card-id">{iidxIdFormatted || iidxId}</div>}
      </div>
      {starResult && (
        <div className="profile-card-star">
          <div className="profile-card-star-value">★{starResult.star.toFixed(2)}</div>
          {secondNote ? (
            <div
              className="profile-card-star-note"
              title={`두번째로 큰 scope: ${secondNote.label}`}
            >
              {secondNote.label}: ★{secondNote.value.toFixed(2)}{' '}
              <span style={{ opacity: 0.7 }}>({secondNote.diffStr})</span>
            </div>
          ) : (
            <div className="profile-card-star-note">DP Recommend</div>
          )}
        </div>
      )}
    </div>
  );
}
