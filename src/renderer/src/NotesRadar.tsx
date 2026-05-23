// NotesRadar — eagate djdata / IIDX 게임 내 노트레이더와 동일한 SVG 6각형 + 호버 시 값 toast.
//
// 핵심 디자인 (ohSorryWeb 의 ohsorryRender 와 동일):
//   - 시계방향 12시 시작 지표 순서: NOTES → PEAK → SCRATCH → SOF-LAN → CHARGE → CHORD
//   - RADAR_MAX = 100 으로 정규화 — 실제 데이터값은 0~200 범위지만 100 으로 over-driven 해서
//     데이터 폴리곤이 격자 밖으로 뻗으며 라벨을 일부 덮는 IIDX 표준 시각화.
//   - 외곽 6각형 + 50% 격자 + 6 spoke (다크 테마용 색).
//   - 폴리곤 fill: 가장 높은 지표의 색 (NOTES 핑크 / PEAK 주황 / SCRATCH 빨강 / SOF-LAN 청록 / CHARGE 보라 / CHORD 초록)
//   - SVG 안에 라벨 표시 (컬러, 데이터 폴리곤에 일부 가려짐), 값은 SVG 밖 호버 toast 에서 6 지표 + 합계.
//
// ProfileCard 높이를 유지하기 위해 size=28 (ohSorryWeb 의 130 의 약 1/5).
// fontSize / R / LR 비율은 ohSorryWeb 와 동일하게 size 의 일정 비율.
// supabase user_radars 한 row (SP=0 / DP=1) 입력. INFOhSorry 는 DP 만 사용.

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
  size?: number;  // SVG 한 변 (px). 기본 50.
}

// 시각 정규화 max. 실제 지표값은 0~200 까지 가능하지만 100 으로 over-driven 해서
// 폴리곤이 격자 밖까지 뻗으며 라벨을 일부 가리는 IIDX 표준 표시.
const RADAR_MAX = 100;

// ohSorryWeb 의 SVG_ORDER 와 동일 — 시계방향 12시 시작.
const SVG_ORDER: { key: keyof RadarValues; label: string; color: string }[] = [
  { key: 'notes',   label: 'NOTES',   color: '#e91e63' },
  { key: 'peak',    label: 'PEAK',    color: '#ff8c00' },
  { key: 'scratch', label: 'SCRATCH', color: '#dc3545' },
  { key: 'soft',    label: 'SOF-LAN', color: '#1ec5e8' },
  { key: 'charge',  label: 'CHARGE',  color: '#b066d8' },
  { key: 'chord',   label: 'CHORD',   color: '#44b544' },
];

// toast 표시 순서 (사용자 캡처 이미지와 동일):
//   NOTES → CHORD → PEAK → CHARGE → SCRATCH → SOF-LAN.
const TOAST_ORDER: { key: keyof RadarValues; label: string; color: string }[] = [
  { key: 'notes',   label: 'NOTES',   color: '#e91e63' },
  { key: 'chord',   label: 'CHORD',   color: '#44b544' },
  { key: 'peak',    label: 'PEAK',    color: '#ff8c00' },
  { key: 'charge',  label: 'CHARGE',  color: '#b066d8' },
  { key: 'scratch', label: 'SCRATCH', color: '#dc3545' },
  { key: 'soft',    label: 'SOF-LAN', color: '#1ec5e8' },
];

// i 번째 꼭짓점 좌표 — 12시 시작 시계방향.
function vertex(i: number, R: number, scale: number, cx: number, cy: number): string {
  const a = -Math.PI / 2 + (i / 6) * 2 * Math.PI;
  const x = cx + Math.cos(a) * R * scale;
  const y = cy + Math.sin(a) * R * scale;
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

function pickNum(v: number | null | undefined): number {
  return typeof v === 'number' && v >= 0 ? v : 0;
}

export function NotesRadar({ data, size = 50 }: NotesRadarProps): JSX.Element | null {
  if (!data) return null;

  const cx = size / 2;
  const cy = size / 2;
  // ohSorryWeb 비율 그대로 — R(격자·데이터 정규화 반지름)/size ≈ 0.29, LR(라벨 거리)/size ≈ 0.385.
  const R = size * 0.29;
  const LR = size * 0.385;
  // ohSorryWeb 의 비율 그대로 — fontSize=8/size=130 ≈ 0.0615. size=28 → 2.
  const fontSize = Math.max(2, Math.round(size * 0.0615));

  const svgValues = SVG_ORDER.map((a) => pickNum(data[a.key]));
  // 가장 높은 지표 색 — 데이터 폴리곤 fill 에 사용.
  const topIdx = svgValues.reduce((maxI, v, i) => (v > svgValues[maxI] ? i : maxI), 0);
  const dataColor = SVG_ORDER[topIdx].color;

  const bgPoly    = SVG_ORDER.map((_, i) => vertex(i, R, 1,   cx, cy)).join(' ');
  const innerPoly = SVG_ORDER.map((_, i) => vertex(i, R, 0.5, cx, cy)).join(' ');
  const dataPoly  = SVG_ORDER.map((_, i) => vertex(i, R, Math.max(svgValues[i] / RADAR_MAX, 0), cx, cy)).join(' ');

  const toastRows = TOAST_ORDER.map((a) => ({ ...a, value: pickNum(data[a.key]) }));
  const total = toastRows.reduce((s, r) => s + r.value, 0);

  return (
    <div className="notes-radar-wrap">
      <svg
        className="notes-radar-svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="DP 노트레이더"
      >
        {/* 외곽 6각형 — 다크 테마용 fill / stroke 은 CSS 에서. */}
        <polygon points={bgPoly} className="notes-radar-bg" />
        {/* 50% 격자 */}
        <polygon points={innerPoly} className="notes-radar-grid" />
        {/* 6 spoke (중심 → 꼭짓점) */}
        {SVG_ORDER.map((_, i) => {
          const ang = -Math.PI / 2 + (i / 6) * 2 * Math.PI;
          const ex = (cx + Math.cos(ang) * R).toFixed(1);
          const ey = (cy + Math.sin(ang) * R).toFixed(1);
          return (
            <line key={`s${i}`} x1={cx} y1={cy} x2={ex} y2={ey} className="notes-radar-spoke" />
          );
        })}
        {/* 라벨 (컬러) — 데이터 폴리곤보다 먼저 그려서 폴리곤(opacity 0.55) 에 일부 가려짐. */}
        {SVG_ORDER.map((a, i) => {
          const ang = -Math.PI / 2 + (i / 6) * 2 * Math.PI;
          const tx = (cx + Math.cos(ang) * LR).toFixed(1);
          const ty = (cy + Math.sin(ang) * LR).toFixed(1);
          return (
            <text
              key={i}
              x={tx} y={ty}
              fill={a.color}
              fontSize={fontSize}
              fontWeight="700"
              textAnchor="middle"
              dominantBaseline="central"
            >
              {a.label}
            </text>
          );
        })}
        {/* 데이터 폴리곤 — 격자/spoke/외곽선 없이 fill 만. 라벨 위에 덮어 일부 가림. */}
        <polygon
          points={dataPoly}
          fill={dataColor}
          fillOpacity={0.55}
        />
      </svg>

      {/* 호버 시 표시되는 toast — 6 지표 + 합계 레이더 스코어. */}
      <div className="notes-radar-toast" role="tooltip">
        {toastRows.map((r) => (
          <div className="notes-radar-toast-row" key={r.key}>
            <span className="notes-radar-toast-label" style={{ color: r.color }}>{r.label}</span>
            <span className="notes-radar-toast-value">{r.value.toFixed(2)}</span>
          </div>
        ))}
        <div className="notes-radar-toast-total">
          <span className="notes-radar-toast-label">합계 레이더 스코어</span>
          <span className="notes-radar-toast-value">{total.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
