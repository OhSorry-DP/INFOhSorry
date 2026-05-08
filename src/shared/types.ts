// main / preload / renderer 가 공유하는 데이터 타입
//
// Reflux TSV 파싱 결과 모델. 메인에서 파싱 후 IPC 로 그대로 전달.

// Reflux Lamp enum (Utils.cs):
//   NP=0 / F=Failed / AC=Assist Clear / EC=Easy Clear / NC=Normal Clear /
//   HC=Hard Clear / EX=EX Hard Clear / FC=Full Combo / PFC=Perfect FC
export type Lamp = 'NP' | 'F' | 'AC' | 'EC' | 'NC' | 'HC' | 'EX' | 'FC' | 'PFC' | string;

export interface ChartCell {
  unlocked: boolean;
  level: number; // Reflux 의 'Rating' 컬럼 = 게임 내 LEVEL (1~12 정수)
  lamp: Lamp;
  letter: string; // DJ Level (AAA/AA/A/B/C/D/E/F)
  exScore: number;
  missCount: number;
  noteCount: number;
  djPoints: number;
}

export type ChartSlot = 'SPB' | 'SPN' | 'SPH' | 'SPA' | 'SPL' | 'DPN' | 'DPH' | 'DPA' | 'DPL';

export interface SongRow {
  title: string;
  type: string;
  label: string;
  charts: Partial<Record<ChartSlot, ChartCell>>;
}

// 곡 row 를 펼쳐서 차트 단위 1행으로 변환한 형태 (ohSorry 모델 input 호환)
export interface SongChart {
  title: string;
  slot: ChartSlot;
  level: number;
  unlocked: boolean;
  lamp: Lamp;
  letter: string;
  exScore: number;
  missCount: number;
  noteCount: number;
  djPoints: number;
}

export const SP_SLOTS: ChartSlot[] = ['SPB', 'SPN', 'SPH', 'SPA', 'SPL'];
export const DP_SLOTS: ChartSlot[] = ['DPN', 'DPH', 'DPA', 'DPL'];

// 곡 row 들에서 (DP slot ∩ level === target) 인 차트만 추출.
// 별값 추정 / 추천곡 모델의 input 이 되는 chart 단위 평탄화.
export function extractCharts(
  rows: SongRow[],
  opts: { slots: ChartSlot[]; level: number },
): SongChart[] {
  const out: SongChart[] = [];
  for (const r of rows) {
    for (const slot of opts.slots) {
      const c = r.charts[slot];
      if (!c) continue;
      if (c.level !== opts.level) continue;
      out.push({
        title: r.title,
        slot,
        level: c.level,
        unlocked: c.unlocked,
        lamp: c.lamp,
        letter: c.letter,
        exScore: c.exScore,
        missCount: c.missCount,
        noteCount: c.noteCount,
        djPoints: c.djPoints,
      });
    }
  }
  return out;
}

// IPC 응답
export interface ProbeResult {
  ok: boolean;
  error?: string;
  pid?: number;
  modBaseAddr?: string;
  modBaseSize?: number;
  modName?: string;
}

export interface TsvReadResult {
  ok: boolean;
  error?: string;
  rows?: SongRow[];
  headerColCount?: number;
  mtime?: number; // 파일의 마지막 수정 시각 (epoch ms)
}

// Reflux manager state
export type RefluxStage =
  | 'idle'
  | 'downloading'
  | 'starting'
  | 'hooking'
  | 'hooked'
  | 'ready'
  | 'error';

export interface RefluxState {
  stage: RefluxStage;
  installed: boolean;
  spawned: boolean;
  download?: { bytes: number; total: number };
  lastTsvMtime?: number;
  error?: string;
  recentLines?: string[]; // Reflux 가 출력한 최근 stdout/stderr 라인 (디버깅용)
}

export interface RefluxStartResult {
  ok: boolean;
  error?: string;
  state: RefluxState;
}

// ereter.net 추출 데이터 (ohSorry 의 ereter-data.json 과 동일 형식)
export interface EreterChart {
  title: string;
  diff: string;
  level: number;
  ec: number | null;
  hc: number | null;
  exh: number | null;
  ec_n: number | null;
  hc_n: number | null;
  exh_n: number | null;
}

export interface EreterData {
  extractedAt: string;
  source: string;
  count: number;
  charts: EreterChart[];
}

export interface EreterGetResult {
  ok: boolean;
  error?: string;
  data?: EreterData;
}

export interface EreterCacheStatus {
  mtime: number | null;
  isStale: boolean;
  exists: boolean;
}
