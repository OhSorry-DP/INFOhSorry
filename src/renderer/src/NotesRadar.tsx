// NotesRadar — eagate djdata 의 6각형 노트레이더 차트.
// 지표 6종 (NOTES / CHORD / PEAK / CHARGE / SCRATCH / SOF-LAN) 을 시계방향 12시부터 그림.
//
// supabase user_radars 테이블의 한 row (SP=0 또는 DP=1) 입력. INFOhSorry 는 DP 만 사용.
// 데이터가 없으면 부모가 컴포넌트 자체를 안 렌더하도록 — 여기서는 null/undefined 입력 시 null 반환.

export interface RadarValues {
  notes: number | null;
  chord: number | null;
  peak: number | null;
  charge: number | null;
  scratch: number | null;
  soft: number | null;  // SOF-LAN
}

interface NotesRadarProps {
  data: RadarValues | null;
  size?: number;   // SVG 한 변 (px). 기본 130.
  maxValue?: number;  // 정규화 상한 (보통 200). null 이면 6 값 max 기준.
}

// 시계방향 12시부터 60° 간격.
// IIDX 게임 / eagate djdata 의 라벨 순서와 동일 (NOTES 12시).
const AXIS_ORDER: { key: keyof RadarValues; label: string }[] = [
  { key: 'notes',   label: 'NOTES' },
  { key: 'chord',   label: 'CHORD' },
  { key: 'peak',    label: 'PEAK' },
  { key: 'charge',  label: 'CHARGE' },
  { key: 'scratch', label: 'SCRATCH' },
  { key: 'soft',    label: 'SOF-LAN' },
];

// 6 꼭짓점 좌표 — 12시 시작 시계방향, 단위원 (r=1) 기준.
//   angle = -90° + i * 60° (deg) → radian
function unitVertex(i: number): { x: number; y: number } {
  const deg = -90 + i * 60;
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad), y: Math.sin(rad) };
}

export function NotesRadar({ data, size = 130, maxValue }: NotesRadarProps): JSX.Element | null {
  if (!data) return null;
  const values = AXIS_ORDER.map((a) => {
    const v = data[a.key];
    return typeof v === 'number' && v >= 0 ? v : 0;
  });
  // 정규화 — props.maxValue 우선, 없으면 6 값 max + 10% 여유 (단 100 이상 보장).
  const dataMax = Math.max(...values, 100);
  const max = maxValue ?? Math.max(dataMax * 1.1, 200);
  const cx = size / 2;
  const cy = size / 2;
  // 라벨 + 차트가 들어갈 공간 — outer radius 는 size 의 32% (라벨 여백 확보).
  const r = size * 0.32;

  // 격자 — 25 / 50 / 75 / 100% 4 단계.
  const gridLevels = [0.25, 0.5, 0.75, 1];
  // 데이터 폴리곤 좌표.
  const dataPts = values.map((v, i) => {
    const u = unitVertex(i);
    const len = (v / max) * r;
    return `${cx + u.x * len},${cy + u.y * len}`;
  }).join(' ');

  // 라벨 위치 — 격자 바깥 살짝.
  const labelR = r * 1.18;

  return (
    <svg
      className="notes-radar-svg"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="DP 노트레이더"
    >
      {/* 격자 6각형 */}
      {gridLevels.map((lv, gi) => {
        const pts = AXIS_ORDER.map((_, i) => {
          const u = unitVertex(i);
          return `${cx + u.x * r * lv},${cy + u.y * r * lv}`;
        }).join(' ');
        return (
          <polygon
            key={gi}
            points={pts}
            fill="none"
            stroke="rgba(255,255,255,0.15)"
            strokeWidth={1}
          />
        );
      })}
      {/* 축 선 */}
      {AXIS_ORDER.map((_, i) => {
        const u = unitVertex(i);
        return (
          <line
            key={i}
            x1={cx} y1={cy}
            x2={cx + u.x * r} y2={cy + u.y * r}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={1}
          />
        );
      })}
      {/* 데이터 폴리곤 */}
      <polygon
        points={dataPts}
        fill="rgba(80,180,255,0.28)"
        stroke="rgba(80,180,255,0.95)"
        strokeWidth={1.4}
      />
      {/* 라벨 + 값 */}
      {AXIS_ORDER.map((a, i) => {
        const u = unitVertex(i);
        const x = cx + u.x * labelR;
        const y = cy + u.y * labelR;
        // 텍스트 정렬 — x 좌표 기반 좌/중/우 분배.
        let anchor: 'start' | 'middle' | 'end' = 'middle';
        if (u.x > 0.3) anchor = 'start';
        else if (u.x < -0.3) anchor = 'end';
        const v = values[i];
        return (
          <g key={i}>
            <text
              x={x} y={y - 4}
              textAnchor={anchor}
              dominantBaseline="middle"
              className="notes-radar-axis-label"
            >
              {a.label}
            </text>
            <text
              x={x} y={y + 7}
              textAnchor={anchor}
              dominantBaseline="middle"
              className="notes-radar-axis-value"
            >
              {v.toFixed(2)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
