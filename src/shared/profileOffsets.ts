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
  refluxVersion: 'P2D:J:B:A:2026042200',
  // DJ NAME — 정적 버퍼, 보통 16~64 byte 길이
  djName: {
    offset: '0x690cbe',
    encoding: 'ascii',
    maxBytes: 64,
  },
  // INFINITAS ID — "C-XXXX-XXXX-XXXX" 형식 14자 (하이픈 포함은 17자)
  // 발견된 메모리에서는 하이픈 없이 13자 (예: "C293036891870")
  iidxId: {
    offset: '0x690cb0',
    encoding: 'ascii',
    maxBytes: 32,
  },
  // SP 단위 — 한자 (中伝, 皆伝, 一段~十段, 무취득은 "-") UTF-16LE 정적 버퍼
  spRank: {
    offset: '0x58d9f8',
    encoding: 'utf16le',
    maxBytes: 32,
  },
  // DP 단위 — SP 와 8바이트 간격 (인접 필드)
  dpRank: {
    offset: '0x58d9f0',
    encoding: 'utf16le',
    maxBytes: 32,
  },
};
