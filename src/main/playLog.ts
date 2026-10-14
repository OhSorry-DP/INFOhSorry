// 플레이 기록기의 순수 로직 (메모리 I/O 없음 — 테스트 가능).
// 상세 문서: docs/play-logger.md

// 게임 모듈의 선호 베이스 주소 (Reflux offsets.txt 의 절대주소 기준)
export const PREFERRED_BASE = 0x140000000n;

// 구조체 내부 상수 (게임 빌드가 바뀌어도 Reflux 와 같은 구조라 고정)
export const PLAY_LOG_LAYOUT = {
  markerScanFromJudge: 144,   // judgeData + 144 부근에서 마커 패턴을 찾는다
  markerDelta: 24,            // magic 위치 + 24 바이트 = 마커
  settingsStateDelta: 0x18,   // PlaySettings - 0x18 == 1 이면 선택 화면 (Reflux FetchGameState)
  p2SettingsDelta: 0x48,      // P2 설정 블록 = P1 설정 블록 + 0x48
  battleFlagDelta: 0x28,      // 배틀 플래그 (PlaySettings 기준). Reflux 소스의 0x20 은 이 빌드에서 안 맞음
  gaugeWordP1: 77,            // judgeData 기준 int32 인덱스 (Reflux PlayData.cs)
  gaugeWordP2: 78,
  playDataWords: 8,           // [곡 ID, 난이도, EX, 미스, PGREAT, GREAT, 클리어 램프, ...]
  songStride: 0x730,          // 곡 엔트리 크기
  songTitleBytes: 0x100,      // 제목 1 (UTF-16LE)
  songIdOffset: 0x5b0,        // 곡 ID (int32)
  songNoteOffset: 0x370,      // 난이도별 노트 수 int32 x 10 (SPB..DPL)
  songCount: 2600,
  settingsWords: 11,
} as const;

export const DIFF_NAMES = ['SPB', 'SPN', 'SPH', 'SPA', 'SPL', 'DPB', 'DPN', 'DPH', 'DPA', 'DPL'];

export const PLAY_LOG_HEADER = [
  'timestamp', 'song_id', 'title', 'difficulty', 'notes', 'ex_score', 'pgreat', 'great', 'miss_count',
  'clear_lamp', 'dj_rate_pct', 'dj_rank', 'judge_16', 'settings_p1_11', 'settings_p2_11', 'battle_flag',
  'gauge_p1_w77', 'gauge_p2_w78',
].join(',');

export type OffsetKey = 'songList' | 'judgeData' | 'playSettings' | 'playData';
export type PlayState = 'playing' | 'select' | 'result';

// Reflux offsets.txt 파싱 (첫 줄 = 버전, 이후 `key = 0xADDR`)
export function parseOffsetsText(text: string): Partial<Record<OffsetKey, bigint>> {
  const out: Partial<Record<OffsetKey, bigint>> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(songList|judgeData|playSettings|playData)\s*=\s*(0x[0-9a-fA-F]+)\s*$/);
    if (m) out[m[1] as OffsetKey] = BigInt(m[2]);
  }
  return out;
}

// 판정 블록 근처 96바이트에서 마커 주소를 찾는다. 없으면 null.
// buf 는 judgeData + markerScanFromJudge 부터 읽은 96바이트
export function findMarkerDelta(buf: Buffer): number | null {
  const idx: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 4) if (buf.readInt32LE(i) > 10000) idx.push(i);
  if (idx.length >= 3 && idx[1] - idx[0] === 8 && idx[2] - idx[1] === 8) return idx[1] + PLAY_LOG_LAYOUT.markerDelta;
  return null;
}

// 마커 값과 PlaySettings-0x18 값으로 상태 판정 (Reflux FetchGameState 와 같은 규칙)
export function decideState(marker: number, playSettingsMinus24: number): PlayState {
  if (marker !== 0) return 'playing';
  return playSettingsMinus24 === 1 ? 'select' : 'result';
}

// EX 레이트 기준 DJ 레벨 (EX / (노트 x 2))
const RANKS: [number, string][] = [[8 / 9, 'AAA'], [7 / 9, 'AA'], [6 / 9, 'A'], [5 / 9, 'B'], [4 / 9, 'C'], [3 / 9, 'D'], [2 / 9, 'E'], [0, 'F']];
export function rankOf(rate: number): string {
  return RANKS.find(([t]) => rate >= t)?.[1] ?? 'F';
}

// 곡 목록 버퍼에서 ID 로 곡명과 난이도별 노트 수를 찾는다
export function lookupSongInBuffer(buf: Buffer, id: number, diff: number): { title: string; notes: number } | null {
  const L = PLAY_LOG_LAYOUT;
  const count = Math.min(L.songCount, Math.floor(buf.length / L.songStride));
  for (let e = 0; e < count; e++) {
    const o = e * L.songStride;
    if (buf.readInt32LE(o + L.songIdOffset) !== id) continue;
    const title = buf.subarray(o, o + L.songTitleBytes).toString('utf16le').replace(/\0.*$/s, '');
    const notes = buf.readInt32LE(o + L.songNoteOffset + diff * 4);
    return { title, notes };
  }
  return null;
}

export function csvField(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export interface PlaySnapshot {
  timestamp: string;
  songId: number;
  title: string;
  diff: number;
  notes: number;
  exScore: number;
  pgreat: number;
  great: number;
  miss: number;
  lamp: number;
  judge16: number[];
  p1Settings: number[];
  p2Settings: number[];
  gauge: [number, number];
}

// 한 플레이 = CSV 한 줄 (PLAY_LOG_HEADER 와 같은 열 순서)
export function buildPlayRow(s: PlaySnapshot): string {
  const rate = s.notes > 0 ? s.exScore / (s.notes * 2) : 0;
  return [
    s.timestamp,
    s.songId,
    csvField(s.title),
    DIFF_NAMES[s.diff] ?? String(s.diff),
    s.notes,
    s.exScore,
    s.pgreat,
    s.great,
    s.miss,
    s.lamp,
    (rate * 100).toFixed(2),
    rankOf(rate),
    csvField(s.judge16.join(' ')),
    csvField(s.p1Settings.join(' ')),
    csvField(s.p2Settings.join(' ')),
    s.p1Settings[PLAY_LOG_LAYOUT.battleFlagDelta / 4] ?? 0,
    s.gauge[0],
    s.gauge[1],
  ].join(',');
}
