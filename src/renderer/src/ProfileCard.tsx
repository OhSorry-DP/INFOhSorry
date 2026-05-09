// ProfileCard — DP12 RECOMMEND 상단에 표시되는 사용자 프로필 카드.
// ohSorry 의 e-amusement 프로필 카드 스타일 따라함 (DJ NAME / IIDX ID / ★).
// 프로필 데이터는 INFINITAS 메모리에서 직접 읽음 (useProfile).
import type { ProfileInfo } from './useProfile';
import type { StarResult } from '../../shared/star-estimator';

interface ProfileCardProps {
  profile: ProfileInfo;
  starResult: StarResult | null;
}

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

export function ProfileCard({ profile, starResult }: ProfileCardProps): JSX.Element | null {
  const { djName, iidxId, iidxIdFormatted, spRank, dpRank } = profile;

  // 메모리 read 가 한 번도 성공 X (게임 로그인 전 등) → 카드 자체 숨김
  if (!djName && !iidxId && !starResult) return null;

  return (
    <div className="profile-card">
      <div className="profile-card-info">
        <div className="profile-card-name-line">
          <span className="profile-card-name">{djName || '(DJ NAME 미확인)'}</span>
          {(spRank || dpRank) && (
            <span className="profile-card-ranks">
              <span className="profile-card-rank-label">SP</span>
              <span className={`profile-card-rank ${rankClass(spRank)}`}>{spRank || '-'}</span>
              <span className="profile-card-rank-label">DP</span>
              <span className={`profile-card-rank ${rankClass(dpRank)}`}>{dpRank || '-'}</span>
            </span>
          )}
        </div>
        {iidxId && <div className="profile-card-id">{iidxIdFormatted || iidxId}</div>}
      </div>
      {starResult && (
        <div className="profile-card-star">
          <div className="profile-card-star-value">★{starResult.star.toFixed(2)}</div>
          <div className="profile-card-star-note">DP Recommend</div>
        </div>
      )}
    </div>
  );
}
