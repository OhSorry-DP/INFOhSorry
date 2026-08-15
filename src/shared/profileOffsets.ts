// INFINITAS player profile 의 메모리 위치 — bm2dx.exe modBase 기준 정적 offset.
//
// 발견 방법: MemoryScanner UI 로 사용자 본인의 DJ NAME / IIDX ID 입력 후 자동 검증으로 찾음.
// 두 값 모두 인접해 (14 bytes 간격) — 같은 player profile struct 안의 필드.
//
// 게임 패치로 .data section layout 이 바뀌면 이 offset 도 깨짐 → MemoryScanner 로 재스캔.
//
// Reflux 의 offsets.txt 처럼 게임 버전을 기록 — 패치 시 검증 가능.
// 메모리 read 시 디코딩 가능한 인코딩들
//   utf16le: Windows wide string
//   utf8: 모던 표준 (한자 3바이트)
//   ascii: Latin-1 호환 (한자 표현 X)
//   shiftjis: 일본어 게임 표준 (한자 2바이트), iconv-lite 로 변환
export type StringEncoding = 'utf16le' | 'utf8' | 'ascii' | 'shiftjis';

export interface ProfileOffsetEntry {
  offset: string; // bigint string (modBase 기준)
  encoding: StringEncoding;
  maxBytes: number;
}

export const PROFILE_OFFSETS: {
  // 발견 당시 게임 버전 (Reflux offsets.txt 의 첫 줄 형식)
  refluxVersion: string;
  djName: ProfileOffsetEntry;
  iidxId: ProfileOffsetEntry;
  spRank?: ProfileOffsetEntry;
  dpRank?: ProfileOffsetEntry;
} = {
  // 2026-04-22 패치로 프로필 struct 가 +0x80 이동 → MemoryScanner 로 재스캔하여 갱신했던 값.
  //   (djName 0x690cbe→0x690d3e, iidxId 0x690cb0→0x690d30, 둘 다 +0x80).
  //   2026-06-03 패치(refluxVersion 2026060300)에서는 djName/iidxId 메모리 offset 변동 없음 — 버전 문자열만 갱신.
  //   2026-08-05 패치에서 struct 가 +0x6fc0 이동 (djName 0x690d3e→0x697cfe, iidxId 0x690d30→0x697cf0).
  //     실행 중인 게임 메모리 직접 스캔으로 확인 (2026-08-15).
  refluxVersion: 'P2D:J:B:A:2026080500',
  // DJ NAME — 정적 버퍼, 보통 16~64 byte 길이
  djName: {
    offset: '0x697cfe',
    encoding: 'utf8',
    maxBytes: 64,
  },
  // INFINITAS ID — "C-XXXX-XXXX-XXXX" 형식 14자 (하이픈 포함은 17자)
  // 발견된 메모리에서는 하이픈 없이 13자 (예: "C293036891870")
  iidxId: {
    offset: '0x697cf0',
    encoding: 'utf8',
    maxBytes: 32,
  },
  // ⚠️ spRank / dpRank (문자열) 은 더 이상 기본값으로 두지 않는다.
  //   옛 offset (0x58d9f8 / 0x58d9f0) 은 플레이어 값이 아니라 **게임의 단위 이름 테이블**
  //   (七級…皆伝 19개, 8바이트 stride) 의 두 칸을 가리키고 있었다. 그래서 누구에게나 같은 문자열이
  //   나오거나 엉뚱한 값이 나왔다 ("단위 리딩이 자주 실패" 의 정체).
  //   실제 플레이어 단위는 프로필 struct 안의 **정수 index** 다 → PROFILE_NUMERIC_OFFSETS.dan.
  //   (사용자가 MemoryScanner 로 직접 저장한 슬롯이 있으면 useProfile 이 여전히 존중한다.)
};

// ---------------------------------------------------------------------------
// 숫자 필드 (노트레이더 / 단위) — 문자열이 아니라 int32 배열로 읽는다.
// ---------------------------------------------------------------------------
export interface ProfileNumericEntry {
  offset: string; // bigint string (modBase 기준)
  count: number; // 연속으로 읽을 int32 개수
  scale?: number; // 표시값 = raw / scale (레이더는 100 배 고정소수점)
}

// 노트레이더 12개 값의 메모리 배치 — 축마다 [SP, DP] 쌍이 연속.
//   +0x00 SP.NOTES   +0x04 DP.NOTES
//   +0x08 SP.PEAK    +0x0c DP.PEAK
//   +0x10 SP.SCRATCH +0x14 DP.SCRATCH
//   +0x18 SP.SOF-LAN +0x1c DP.SOF-LAN
//   +0x20 SP.CHARGE  +0x24 DP.CHARGE
//   +0x28 SP.CHORD   +0x2c DP.CHORD
// 값은 100 배 정수 (9234 = 92.34). 합계 레이더 스코어는 저장 안 됨 — 6개 합으로 계산.
export const RADAR_AXIS_ORDER = [
  'notes',
  'peak',
  'scratch',
  'soft',
  'charge',
  'chord',
] as const;
export type RadarAxis = (typeof RADAR_AXIS_ORDER)[number];

export const PROFILE_NUMERIC_OFFSETS: {
  radar?: ProfileNumericEntry;
  dan?: ProfileNumericEntry;
} = {
  // 게임 빌드 2026080500 기준 (위 refluxVersion 과 동일 스캔에서 확인).
  radar: { offset: '0x699790', count: 12, scale: 100 },
  // 단위 — [SP, DP] 인접 int32. 값은 아래 DAN_NAMES 의 index, 미취득은 -1.
  //   같은 struct 의 DJ POINT 도 [SP=0x697d14, DP=0x697d18] 순서라 SP→DP 배치가 일관된다.
  dan: { offset: '0x697d1c', count: 2 },
};

// 게임 내부 단위 index → 표기. 게임 메모리의 이름 테이블 (bm2dx+0x592970, 8바이트 stride) 과 동일 순서.
export const DAN_NAMES = [
  '七級', '六級', '五級', '四級', '三級', '二級', '一級',
  '初段', '二段', '三段', '四段', '五段', '六段', '七段', '八段', '九段', '十段',
  '中伝', '皆伝',
] as const;

// 게임 index → supabase users.sp_rank/dp_rank 스케일 (12=皆伝 / 11=中伝 / 10~1=十段~初段 / 0=一級 / -8~-1=九級~二級).
//   一級 이 양쪽 0 이라 단순히 -6 시프트. 미취득(-1) / 범위 밖은 null.
export function danIndexToRankInt(idx: number | null | undefined): number | null {
  if (typeof idx !== 'number' || !Number.isInteger(idx)) return null;
  if (idx < 0 || idx >= DAN_NAMES.length) return null; // -1 = 미취득
  return idx - 6;
}

// ---------------------------------------------------------------------------
// gist offsets.json 의 profile 맵 항목 타입 (main 이 fetch → IPC 로 renderer 에 전달).
//   문자열 필드(djName/iidxId)와 숫자 필드(radar/dan)가 **같은 맵에 섞여** 온다.
//   구분은 키 이름이 아니라 모양으로 한다 — 문자열엔 encoding, 숫자엔 count.
//   값이 null 이면 "이 빌드에서 그 주소를 아직 모른다" → 읽기 skip (키 생략 = 코드 상수 fallback 과 다름).
// ---------------------------------------------------------------------------
export interface RemoteStringOffset {
  offset: string;
  encoding: string; // StringEncoding. gist 는 임의 문자열이 올 수 있어 좁히지 않는다.
  maxBytes?: number;
}
export interface RemoteNumericOffset {
  offset: string;
  count: number;
  scale?: number; // 표시값 = raw / scale. 생략 시 호출부 기본값(레이더 100).
}
export type RemoteProfileEntry = RemoteStringOffset | RemoteNumericOffset;
export type RemoteProfileMap = Record<string, RemoteProfileEntry | null>;

// gist 는 사람이 손으로 고치는 파일이라 모양이 틀릴 수 있다 → 런타임 가드로 걸러내고,
//   통과 못 하면 호출부가 코드 상수로 fallback 한다 (엉뚱한 주소를 읽느니 상수가 낫다).
export function isRemoteNumericOffset(e: unknown): e is RemoteNumericOffset {
  const v = e as RemoteNumericOffset | null;
  return !!v && typeof v.offset === 'string' && Number.isInteger(v.count) && v.count > 0;
}
export function isRemoteStringOffset(e: unknown): e is RemoteStringOffset {
  const v = e as RemoteStringOffset | null;
  return !!v && typeof v.offset === 'string' && typeof v.encoding === 'string';
}
