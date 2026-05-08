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
import { useMemo, useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import type { ChartSlot, SongChart } from '../../shared/types';
import { lampNum } from '../../shared/match';

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

type SortBy = 'title' | 'lamp';

export default function Dp12Table({ charts }: Props) {
  const [sortBy, setSortBy] = useState<SortBy>('title');
  const [capturing, setCapturing] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  async function captureGrid(): Promise<void> {
    if (!gridRef.current) return;
    setCapturing(true);
    try {
      const canvas = await html2canvas(gridRef.current, {
        backgroundColor: '#ffffff',
        scale: window.devicePixelRatio || 1,
        useCORS: true,
        logging: false,
      });
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return;
      const buf = await blob.arrayBuffer();
      const ts = new Date()
        .toISOString()
        .replace(/[:T.]/g, '-')
        .replace('Z', '');
      const r = await window.infohsorry.saveImage(buf, `dp12-${ts}.png`);
      if (r.ok && r.path) {
        alert(`캡처 저장됨\n${r.path}`);
      } else {
        alert(`캡처 실패: ${r.error || '알 수 없음'}`);
      }
    } finally {
      setCapturing(false);
    }
  }

  // ereter 매칭된 곡 — ★ 레벨로 그룹. 매칭 안 된 곡은 '미분류' 그룹 (★11.6 아래)
  // 그룹 정렬: 큰 ★ → 작은 ★ → 미분류 (가장 아래)
  // 그룹 내 정렬: 곡명 순 또는 램프 강한 순
  const groups = useMemo(() => {
    const UNCLASSIFIED = -1;
    const m = new Map<number, SongChart[]>();
    for (const c of charts) {
      const lv = c.ereterLevel ?? UNCLASSIFIED;
      if (!m.has(lv)) m.set(lv, []);
      m.get(lv)!.push(c);
    }
    const sorted = Array.from(m.entries()).sort((a, b) => {
      if (a[0] === UNCLASSIFIED) return 1;
      if (b[0] === UNCLASSIFIED) return -1;
      return b[0] - a[0];
    });
    for (const [, arr] of sorted) {
      if (sortBy === 'title') {
        arr.sort((a, b) => a.title.localeCompare(b.title));
      } else {
        arr.sort((a, b) => {
          const ln = lampNum(b.lamp) - lampNum(a.lamp);
          if (ln !== 0) return ln;
          return a.title.localeCompare(b.title);
        });
      }
    }
    return sorted;
  }, [charts, sortBy]);

  if (groups.length === 0) {
    return <div className="dp12-empty">매칭된 DP ☆12 곡이 없습니다.</div>;
  }

  return (
    <div>
      <div className="dp12-sort">
        <button
          className={`dp12-sort-btn${sortBy === 'title' ? ' active' : ''}`}
          onClick={() => setSortBy('title')}
        >
          곡명 순
        </button>
        <span className="dp12-sort-sep">|</span>
        <button
          className={`dp12-sort-btn${sortBy === 'lamp' ? ' active' : ''}`}
          onClick={() => setSortBy('lamp')}
        >
          램프 순
        </button>
        <button
          className="dp12-capture-btn"
          onClick={captureGrid}
          disabled={capturing}
          title="격자 영역을 PNG 이미지로 저장"
        >
          {capturing ? '캡처 중...' : '캡처'}
        </button>
      </div>
      <div className="dp12-grid" ref={gridRef}>
          {groups.map(([level, list]) => (
          <div key={level} className="dp12-group">
            <div className="dp12-level">{level === -1 ? '미분류' : level.toFixed(1)}</div>
            <div className="dp12-songs">
              {list.map((c, i) => (
                <SongCell key={`${c.title}|${c.slot}|${i}`} c={c} />
              ))}
            </div>
          </div>
        ))}
      </div>
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
