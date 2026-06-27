// ProfileCard — DP12 RECOMMEND 상단에 표시되는 사용자 프로필 카드.
// ohSorry 의 e-amusement 프로필 카드 스타일 따라함 (DJ NAME / IIDX ID / ★).
// 프로필 데이터는 INFINITAS 메모리에서 직접 읽음 (useProfile).
import { useState } from 'react';
import type { ProfileInfo } from './useProfile';
import type { StarResult } from '../../shared/types';
import type { DpRadarRow } from './supabaseSync';

const STAR_CLICK_COOLDOWN_MS = 30 * 1000;
import { NotesRadar } from './NotesRadar';

interface ProfileCardProps {
  profile: ProfileInfo;
  starResult: StarResult | null;
  // OSR (osr v0.0.2) 표시값. starResult (채택 ★) 와의 차이 함께 표시. null 이면 "DP Recommend" 표시.
  osrStar?: number | null;
  // SP 대표 실력값(発狂★相当 = cpiToHakkyoStar(sp_cpi)). DP★ 와 다른 스케일(발광 환산)이라 라벨로 구분 병행 표시. null 이면 SP 미표시.
  spStar?: number | null;
  // supabase user_radars (play_style=1) row. null 이면 레이더 영역 자체 숨김.
  dpRadar?: DpRadarRow | null;
  // supabase users.sp_rank / dp_rank (int). null 이면 해당 단위 표시 숨김.
  // int 매핑 — setup_users.sql: 12=皆伝 / 11=中伝 / 10~1=十段~初段 / 0=一級 / -8~-1=九級~二級.
  spRank?: number | null;
  dpRank?: number | null;
  // ★ 표시 클릭 시 호출 — tsv 재로드 트리거 (DB upload 없이 재계산만).
  onStarClick?: () => void;
}

// supabase 의 int 단위 코드 → 한자 표기 (eagate djdata 와 동일).
// 매핑 외 값은 null.
function rankIntToKanji(rankInt: number | null | undefined): string | null {
  if (typeof rankInt !== 'number') return null;
  if (rankInt === 12) return '皆伝';
  if (rankInt === 11) return '中伝';
  if (rankInt >= 1 && rankInt <= 10) {
    return ['初', '二', '三', '四', '五', '六', '七', '八', '九', '十'][rankInt - 1] + '段';
  }
  if (rankInt >= -8 && rankInt <= 0) {
    // 0 → 一級, -1 → 二級, ..., -8 → 九級
    return ['一', '二', '三', '四', '五', '六', '七', '八', '九'][-rankInt] + '級';
  }
  return null;
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

export function ProfileCard({
  profile,
  starResult,
  osrStar,
  spStar,
  dpRadar,
  spRank,
  dpRank,
  onStarClick,
}: ProfileCardProps): JSX.Element | null {
  const { djName, iidxId, iidxIdFormatted } = profile;
  const [starCooling, setStarCooling] = useState(false);
  const handleStarClick = (): void => {
    if (starCooling || !onStarClick) return;
    setStarCooling(true);
    onStarClick();
    window.setTimeout(() => setStarCooling(false), STAR_CLICK_COOLDOWN_MS);
  };
  const spRankStr = rankIntToKanji(spRank);
  const dpRankStr = rankIntToKanji(dpRank);

  // 메모리 read 가 한 번도 성공 X (게임 로그인 전 등) → 카드 자체 숨김
  if (!djName && !iidxId && !starResult && spStar == null) return null;

  // native(onlyOSR) 표시: 표시 ★ (ereterStar) 와의 차이 함께
  const osrNote = (() => {
    if (!starResult || typeof osrStar !== 'number') return null;
    const diff = osrStar - starResult.star;
    const diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(2);
    return { value: osrStar, diffStr };
  })();

  return (
    <div className="profile-card">
      <div className="profile-card-info">
        <div className="profile-card-name-line">
          <span className="profile-card-name">{djName || '(DJ NAME 미확인)'}</span>
          {(spRankStr || dpRankStr) && (
            <span className="profile-card-ranks">
              {/* SP/DP 둘 다 라벨은 항상 표시 — 값 없는 쪽은 "-" (예: "SP -   DP 十段").
                  둘 다 null 이면 부모 if 가 영역 통째 숨김. */}
              <span className="profile-card-rank-label">SP</span>
              <span className={'profile-card-rank ' + (spRankStr ? rankClass(spRankStr) : '')}>
                {spRankStr || '-'}
              </span>
              <span className="profile-card-rank-label">DP</span>
              <span className={'profile-card-rank ' + (dpRankStr ? rankClass(dpRankStr) : '')}>
                {dpRankStr || '-'}
              </span>
            </span>
          )}
        </div>
        {iidxId && <div className="profile-card-id">{iidxIdFormatted || iidxId}</div>}
      </div>
      {/* 6각형 차트 — info(단위 포함) 바로 오른쪽. row 없으면 영역 숨김. */}
      {dpRadar && (
        <div className="profile-card-radar" title="DP 노트레이더 (eagate djdata 기반)">
          <NotesRadar data={dpRadar} />
        </div>
      )}
      {(starResult || spStar != null) && (
        <div className="profile-card-star">
          {/* SP/DP 병행 — DP=기존 ★(ereter 스케일), SP=発狂★相当(cpi 환산). 스케일이 달라 라벨로 구분.
              클릭 재계산은 DP(tsv 재로드) 기준 — SP★ 도 같은 rows 재계산으로 함께 갱신됨. */}
          <div
            className="profile-card-star-value"
            onClick={onStarClick ? handleStarClick : undefined}
            title={onStarClick ? (starCooling ? '재계산 쿨다운 중 (30초)' : '클릭 시 재계산 (DB upload 없이)') : undefined}
            style={onStarClick ? { cursor: starCooling ? 'wait' : 'pointer', opacity: starCooling ? 0.5 : 1 } : undefined}
          >
            {spStar != null && (
              <span className="profile-card-star-sp" title="SP 発狂★相当 (cpi 실력선 환산)">SP ★{spStar.toFixed(2)}</span>
            )}
            {spStar != null && starResult && <span style={{ opacity: 0.4, margin: '0 6px' }}>/</span>}
            {starResult && (
              <span className="profile-card-star-dp" title="DP ★ (ereter 스케일)">DP ★{starResult.star.toFixed(2)}</span>
            )}
          </div>
          {starResult && (osrNote ? (
            <div className="profile-card-star-note" title="native (onlyOSR 전체곡 50%) 추정값">
              native: ★{osrNote.value.toFixed(2)}{' '}
              <span style={{ opacity: 0.7 }}>({osrNote.diffStr})</span>
            </div>
          ) : (
            <div className="profile-card-star-note">DP Recommend</div>
          ))}
        </div>
      )}
    </div>
  );
}
