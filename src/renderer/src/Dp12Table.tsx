// DP ☆12 차트만 평탄화한 1차트 = 1행 표
//
// ohSorry 의 별값 추정 / 추천곡 모델의 input 형식과 매칭됨.
// 사용자가 한 곡의 4개 DP 차트 (DPN/DPH/DPA/DPL) 중 ☆12 인 것만 골라내서 보여줌.
import { useMemo } from 'react';
import type { SongChart } from '../../shared/types';
import { lampStyle, letterColor } from './lampStyle';

interface Props {
  charts: SongChart[];
}

const SLOT_LABEL: Record<string, string> = {
  DPN: 'NORMAL',
  DPH: 'HYPER',
  DPA: 'ANOTHER',
  DPL: 'LEGGENDARIA',
};
const SLOT_COLOR: Record<string, string> = {
  DPN: '#1971c2',
  DPH: '#dcaf45',
  DPA: '#dc3545',
  DPL: '#d678c8',
};

// lamp 강함 순서 (Reflux enum 기준, PFC 가 가장 위)
const LAMP_RANK: Record<string, number> = {
  PFC: 8,
  FC: 7,
  EX: 6,
  HC: 5,
  NC: 4,
  EC: 3,
  AC: 2,
  F: 1,
  NP: 0,
};

export default function Dp12Table({ charts }: Props) {
  // 정렬: 강한 lamp 우선 → 같은 lamp 면 EX score 내림차순 → title
  const sorted = useMemo(
    () =>
      [...charts].sort((a, b) => {
        const la = LAMP_RANK[a.lamp] ?? -1;
        const lb = LAMP_RANK[b.lamp] ?? -1;
        if (la !== lb) return lb - la;
        if (a.exScore !== b.exScore) return b.exScore - a.exScore;
        return a.title.localeCompare(b.title);
      }),
    [charts],
  );

  // grid 가 .dp12-table 의 직계 자식만 셀로 잡으므로 thead / tr 는 display:contents 로
  // 자식을 직접 grid 셀로 펼침. tbody wrapper 는 두면 grid 흐름이 끊겨서 생략.
  return (
    <div className="dp12-table">
      <div className="dp12-thead">
        <div className="num">★</div>
        <div>곡명</div>
        <div>차트</div>
        <div className="num">RANK</div>
        <div className="num">EX</div>
        <div className="num">MISS</div>
        <div className="num">NOTES</div>
        <div className="num">BP%</div>
        <div>LAMP</div>
      </div>
      {sorted.map((c, i) => {
        const ls = lampStyle(c.lamp);
        const slotColor = SLOT_COLOR[c.slot] || '#888';
        const bp = c.noteCount > 0 ? (c.missCount / c.noteCount) * 100 : null;
        return (
          <div key={`${c.title}|${c.slot}|${i}`} className="dp12-tr">
            <div className="num ereter-level">
              {c.ereterLevel != null ? `★${c.ereterLevel.toFixed(1)}` : '-'}
            </div>
            <div className="title">{c.title}</div>
            <div className="slot" style={{ color: slotColor }}>
              {SLOT_LABEL[c.slot]}
            </div>
            <div className="num letter" style={{ color: letterColor(c.letter) }}>
              {c.letter || '-'}
            </div>
            <div className="num">{c.exScore > 0 ? c.exScore.toLocaleString() : '-'}</div>
            <div className="num">
              {c.missCount === 0 && c.lamp === 'NP' ? '-' : c.missCount}
            </div>
            <div className="num">{c.noteCount > 0 ? c.noteCount : '-'}</div>
            <div className="num">{bp != null ? bp.toFixed(2) : '-'}</div>
            <div className="lamp" style={{ color: ls.color, background: ls.bg }}>
              {ls.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
