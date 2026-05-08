// main / preload / renderer 가 공유하는 데이터 타입
//
// Reflux TSV 파싱 결과 모델. 메인에서 파싱 후 IPC 로 그대로 전달.

export type Lamp =
  | 'NP'
  | 'Failed'
  | 'Assist'
  | 'Easy'
  | 'Clear'
  | 'Hard'
  | 'ExHard'
  | 'FullCombo'
  | string;

export interface ChartCell {
  unlocked: boolean;
  rating: string;
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

export const SP_SLOTS: ChartSlot[] = ['SPB', 'SPN', 'SPH', 'SPA', 'SPL'];
export const DP_SLOTS: ChartSlot[] = ['DPN', 'DPH', 'DPA', 'DPL'];

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
}
