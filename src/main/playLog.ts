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
  playSpeedFromSettings: 0x17a0, // playSettings + 0x17a0 = 옵션창 「곡 재생 속도」 단계 (int32). 속도 = 1.5 - 0.05 x 값 (값 10 = 1.00)
  playDataWords: 8,          // [곡 ID, 난이도, EX, 미스, PGREAT, GREAT, 클리어 램프, ...]
  currentSongWords: 5,        // [곡 ID, 난이도(스타일 안 인덱스), ?, ?, 노트 수]. 배틀에서도 채워진다
  songStride: 0x730,          // 곡 엔트리 크기
  songTitleBytes: 0x100,      // 제목 1 (UTF-16LE)
  songIdOffset: 0x5b0,        // 곡 ID (int32)
  songNoteOffset: 0x370,      // 난이도별 노트 수 int32 x 10 (SPB..DPL)
  songCount: 2600,
  settingsWords: 11,
} as const;

export const DIFF_NAMES = ['SPB', 'SPN', 'SPH', 'SPA', 'SPL', 'DPB', 'DPN', 'DPH', 'DPA', 'DPL'];

// play_speed 열 추가 전(21열) 헤더. 그 전에 만든 plays.csv 의 첫 줄을 새 헤더로 올릴 때 비교용
export const PLAY_LOG_HEADER_V2 = [
  'timestamp', 'song_id', 'title', 'difficulty', 'notes', 'ex_score', 'pgreat', 'great', 'miss_count',
  'clear_lamp', 'dj_rate_pct', 'dj_rank', 'judge_16', 'settings_p1_11', 'settings_p2_11', 'battle_flag',
  'gauge_p1_w77', 'gauge_p2_w78', 'source', 'app_version', 'game_version',
].join(',');
export const PLAY_LOG_HEADER = PLAY_LOG_HEADER_V2 + ',play_speed';

// 옵션창 속도 단계(int32) -> 배율. 0.80/0.85/0.90/1.00/1.05 에서 14/13/12/10/9 로 확인. 범위 밖이면 null
export function playSpeedFromSettingValue(v: number): number | null {
  return Number.isInteger(v) && v >= 0 && v <= 30 ? Math.round((1.5 - 0.05 * v) * 100) / 100 : null;
}

// 속도 배율 float 를 CSV 값으로: 정상 범위(0.1~10)면 소수 둘째 자리, 아니면 빈 값
export function formatPlaySpeed(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0.1 && v <= 10 ? v.toFixed(2) : '';
}

export type OffsetKey = 'songList' | 'judgeData' | 'playSettings' | 'playData' | 'currentSong';
export type PlayState = 'playing' | 'select' | 'result';
// 한 줄의 곡·점수 정보를 어느 블록에서 얻었는가: PlayData(일반) / CurrentSong + 판정 블록(배틀)
export type PlaySource = 'playdata' | 'currentsong';

const OFFSET_KEYS: Record<string, OffsetKey> = {
  songlist: 'songList',
  judgedata: 'judgeData',
  playsettings: 'playSettings',
  playdata: 'playData',
  currentsong: 'currentSong',
};

// Reflux offsets.txt 파싱 (첫 줄 = 버전, 이후 `key = 0xADDR`). 키 대소문자는 구분하지 않는다.
export function parseOffsetsText(text: string): Partial<Record<OffsetKey, bigint>> {
  const out: Partial<Record<OffsetKey, bigint>> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z]+)\s*=\s*(0x[0-9a-fA-F]+)\s*$/);
    const key = m ? OFFSET_KEYS[m[1].toLowerCase()] : undefined;
    if (m && key) out[key] = BigInt(m[2]);
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
    const notes = diff >= 0 && diff < DIFF_NAMES.length ? buf.readInt32LE(o + L.songNoteOffset + diff * 4) : 0;
    return { title, notes };
  }
  return null;
}

export interface ResolvedPlay {
  songId: number;
  diff: number;
  exScore: number;
  pgreat: number;
  great: number;
  miss: number;
  lamp: number;
  source: PlaySource;
  /** CurrentSong 에서 읽은 노트 수 (source = currentsong 일 때만). 배틀은 양쪽 합계(= 차트 노트 x 2) */
  currentNotes: number | null;
}

// 결과 한 건의 곡·점수 정보를 정한다.
// - 배틀(플래그 ON)은 게임이 기록을 저장하지 않아 PlayData 가 비거나 이전 플레이 값이 남을 수 있다.
//   그래서 배틀이면 항상 CurrentSong 에서 곡 ID·난이도·노트 수를 읽고, EX·미스·PGREAT·GREAT 는
//   판정 블록(양쪽 합)으로 계산한다. 난이도는 SP 인덱스(SPB=0..SPL=4)다.
// - 곡 재생 속도가 1.00 이 아니면(speedChanged) 게임이 PlayData 를 저장하지 않으므로(옵션창 안내문 그대로 비어 있음 확인)
//   배틀과 같은 방식(CurrentSong + 판정 블록)으로 만든다. 다만 DP 일 수 있어 난이도는 노트 수로 SP/DP 를 가린다:
//   CurrentSong 노트 수가 곡 목록의 DP 차트 노트 수와 같고 SP 와 다르면 DP(난이도 = 인덱스 + 5), 아니면 SP.
//   둘 다 같거나 못 찾으면 P2 판정 합이 0 보다 크면 DP 로 본다.
// - 그 외 배틀이 아니면 PlayData 를 그대로 쓴다.
// - 어느 쪽도 쓸 수 없으면 저장할 플레이가 아니므로 null.
export function resolvePlay(input: {
  playData: number[];
  currentSong: number[];
  judge16: number[];
  battle: boolean;
  /** 곡 재생 속도가 1.00 이 아님 (PlayData 가 저장되지 않는 플레이) */
  speedChanged?: boolean;
  /** CurrentSong 곡의 SP/DP 같은 난이도 차트 노트 수 (곡 목록에서 조회). speedChanged 일 때 SP/DP 판별용 */
  chartNotes?: { sp: number; dp: number };
}): ResolvedPlay | null {
  const pd = input.playData;
  const cs = input.currentSong;
  const j = input.judge16;
  if (input.battle) {
    if (cs[0] === 0 || j.length < 10) return null;
    const pgreat = j[0] + j[5];
    const great = j[1] + j[6];
    return {
      songId: cs[0],
      diff: cs[1],
      exScore: 2 * pgreat + great,
      pgreat,
      great,
      miss: j[3] + j[4] + j[8] + j[9], // BAD + POOR (양쪽)
      lamp: -1, // 배틀은 클리어 램프가 저장되지 않는다
      source: 'currentsong',
      currentNotes: cs[4],
    };
  }
  if (input.speedChanged) {
    if (cs[0] === 0 || j.length < 10) return null;
    const n = input.chartNotes;
    const p2 = j[5] + j[6] + j[7] + j[8] + j[9];
    const isDp = n && n.dp !== n.sp && (cs[4] === n.dp || cs[4] === n.sp) ? cs[4] === n.dp : p2 > 0;
    const pgreat = j[0] + j[5];
    const great = j[1] + j[6];
    return {
      songId: cs[0],
      diff: isDp ? cs[1] + 5 : cs[1],
      exScore: 2 * pgreat + great,
      pgreat,
      great,
      miss: j[3] + j[4] + j[8] + j[9],
      lamp: -1, // 저장되지 않은 플레이라 클리어 램프를 알 수 없다
      source: 'currentsong',
      currentNotes: cs[4],
    };
  }
  if (pd[0] === 0) return null;
  return { songId: pd[0], diff: pd[1], exScore: pd[2], miss: pd[3], pgreat: pd[4], great: pd[5], lamp: pd[6], source: 'playdata', currentNotes: null };
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
  source: PlaySource;
  appVersion: string;
  gameVersion: string;
  /** 곡 재생 속도 배율 (0.7 = 0.7배). 읽지 못했으면 null/생략 */
  playSpeed?: number | null;
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
    s.source,
    csvField(s.appVersion),
    csvField(s.gameVersion),
    formatPlaySpeed(s.playSpeed),
  ].join(',');
}
