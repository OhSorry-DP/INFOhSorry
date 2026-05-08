// DP ☆12 격자 표 — ereter ★ 레벨로 그룹화, 곡명만 표시, hover 시 상세 정보
//
// 레이아웃:
//   ┌─────────┬─────────────────────────────────┐
//   │ ★12.7   │ 곡A  곡B  곡C  ...                │
//   ├─────────┼─────────────────────────────────┤
//   │ ★12.6   │ ...                             │
//   ├─────────┼─────────────────────────────────┤
//   ...
//
// 각 곡 cell: 차트 slot 별 옅은 배경 색 (DPN/DPH/DPA/DPL)
//             LEGGENDARIA 는 † + 마젠타 글자
//             hover title 에 lamp / EX / rate / miss / notes 표시
import { useMemo } from 'react';
import type { ChartSlot, SongChart } from '../../shared/types';

interface Props {
  charts: SongChart[];
}

const SLOT_LABEL: Record<string, string> = {
  DPN: 'NORMAL',
  DPH: 'HYPER',
  DPA: 'ANOTHER',
  DPL: 'LEGGENDARIA',
};

const LAMP_LABEL: Record<string, string> = {
  NP: 'NO PLAY',
  F: 'FAILED',
  AC: 'ASSIST',
  EC: 'EASY',
  NC: 'CLEAR',
  HC: 'HARD',
  EX: 'EX-HARD',
  FC: 'FULL COMBO',
  PFC: 'PERFECT FC',
};

export default function Dp12Table({ charts }: Props) {
  // ereter ★ 매칭된 곡만 그룹화 (매칭 안 된 곡은 ★ 모르니 제외)
  // 레벨 내림차순 → 같은 레벨 안에서는 곡명 순
  const groups = useMemo(() => {
    const m = new Map<number, SongChart[]>();
    for (const c of charts) {
      if (c.ereterLevel == null) continue;
      const lv = c.ereterLevel;
      if (!m.has(lv)) m.set(lv, []);
      m.get(lv)!.push(c);
    }
    const sorted = Array.from(m.entries()).sort((a, b) => b[0] - a[0]);
    for (const [, arr] of sorted) arr.sort((a, b) => a.title.localeCompare(b.title));
    return sorted;
  }, [charts]);

  if (groups.length === 0) {
    return <div className="dp12-empty">매칭된 DP ☆12 곡이 없습니다.</div>;
  }

  return (
    <div className="dp12-grid">
      {groups.map(([level, list]) => (
        <div key={level} className="dp12-group">
          <div className="dp12-level">★{level.toFixed(1)}</div>
          <div className="dp12-songs">
            {list.map((c, i) => (
              <SongCell key={`${c.title}|${c.slot}|${i}`} c={c} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SongCell({ c }: { c: SongChart }) {
  const isLegg = c.slot === 'DPL';
  const played = c.lamp !== 'NP' && c.unlocked;
  const rate = played && c.noteCount > 0 ? (c.exScore / (c.noteCount * 2)) * 100 : null;
  const lampLabel = LAMP_LABEL[c.lamp] ?? c.lamp;
  const slotLabel = SLOT_LABEL[c.slot as ChartSlot] ?? c.slot;

  // hover tooltip — native title (한 줄씩)
  const tooltip = [
    `${c.title}`,
    `${slotLabel} · ${lampLabel}`,
    !c.unlocked
      ? '잠김'
      : played
      ? `EX ${c.exScore.toLocaleString()} (${rate?.toFixed(2)}%)\n${
          c.letter || '-'
        } · MISS ${c.missCount} / NOTES ${c.noteCount}`
      : `NOTES ${c.noteCount}`,
  ].join('\n');

  return (
    <div className={`dp12-song slot-${c.slot} lamp-${c.lamp}`} title={tooltip}>
      <span className={`lamp-box lamp-${c.lamp}`} />
      <span className="dp12-song-text">{(isLegg ? '† ' : '') + c.title}</span>
    </div>
  );
}
