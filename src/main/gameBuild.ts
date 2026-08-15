// 실행 중인 INFINITAS 의 빌드 datecode(`P2D:J:B:A:YYYYMMDDxx`) 를 읽는다.
//
// 왜 이 방식인가:
//   패치마다 메모리 offset 이 흩어지는데, "지금 돌고 있는 게 어느 빌드인가" 를 알아야
//   빌드별 offset 을 골라 쓸 수 있다. exe 의 PE 타임스탬프/파일크기로 지문을 만드는 방법도
//   있지만, 그건 빌드를 간접 추론하는 것이라 빌드마다 지문을 따로 수집해 둬야 한다.
//   게임은 자기 버전 문자열을 메모리에 그대로 들고 있으므로 그걸 직접 읽는 게 정확하다.
//   (Reflux 가 쓰는 방법과 동일 — Program.cs 가 modBase 부터 훑어 "P2D:J:B:A:" 를 찾는다.)
//
// offset 하드코딩이 없어서 패치에 깨지지 않는 것이 이 방식의 핵심 장점이다.
import { findInfinitas, readBytes, closeHandle } from './memory';

const EXE_NAME = 'bm2dx.exe';
const PREFIX = 'P2D:J:B:A:';
const DATECODE_LEN = 10; // 접두사 뒤 YYYYMMDDxx
const CHUNK = 4 * 1024 * 1024;

// 마지막으로 확인한 datecode — 게임이 꺼져 있을 때 fallback.
//   Reflux offsets.txt 는 게임 기동 전에 준비되므로(startAll) 그 시점엔 프로세스가 없을 수 있다.
let _cache: { datecode: string; at: number } | null = null;

// datecode 문자열에서 끝 10자리 숫자만 뽑는다. 클수록 최신. 파싱 실패 시 0.
export function datecodeNum(datecode: string): number {
  const m = (datecode || '').trim().match(/(\d{10})\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

// bm2dx.exe 의 모듈 범위를 훑어 datecode 를 찾는다. 게임 미실행/미발견이면 null.
//   전체 프로세스 메모리가 아니라 주 모듈 범위(보통 ~70MB)만 본다.
//
// ⚠️ 첫 매치에서 멈추면 안 된다. 모듈 안에는 옛 빌드 문자열이 상수로 여럿 박혀 있고
//   (실측: 2016090700 / 2026031200 / 2022031600 / 2016051600 이 실제 빌드 2026080500 보다 앞에 있음)
//   앞쪽 매치를 잡으면 resolveBuild 가 엉뚱한 빌드로 매칭된다.
//   전부 훑어 **가장 큰 datecode** 를 고른다 — 실행 중인 빌드가 그 프로세스 안에서 가장 최신이다.
function scanDatecode(): string | null {
  let inf: ReturnType<typeof findInfinitas> = null;
  try {
    inf = findInfinitas(EXE_NAME);
  } catch {
    return null; // OpenProcess 실패(권한 등)
  }
  if (!inf) return null;

  const pattern = Buffer.from(PREFIX, 'ascii');
  const total = inf.modBaseSize;
  // 청크 경계에 걸친 매치를 놓치지 않도록 (패턴 + datecode) 만큼 겹쳐 읽는다.
  const overlap = pattern.length + DATECODE_LEN;
  const valid = new RegExp(`^${PREFIX}\\d{${DATECODE_LEN}}$`);
  let best: string | null = null;
  try {
    for (let off = 0; off < total; off += CHUNK - overlap) {
      const size = Math.min(CHUNK, total - off);
      if (size <= 0) break;
      let buf: Buffer;
      try {
        buf = readBytes(inf.handle, inf.modBaseAddr + BigInt(off), size);
      } catch {
        continue; // 읽을 수 없는 구간은 건너뛴다
      }
      let idx = 0;
      for (;;) {
        const found = buf.indexOf(pattern, idx);
        if (found < 0) break;
        const cand = buf
          .subarray(found, found + pattern.length + DATECODE_LEN)
          .toString('ascii');
        if (valid.test(cand) && (!best || datecodeNum(cand) > datecodeNum(best))) best = cand;
        idx = found + 1;
      }
    }
  } finally {
    closeHandle(inf.handle);
  }
  return best;
}

// 현재 빌드 datecode. 게임이 떠 있으면 실측, 아니면 이번 프로세스에서 마지막으로 본 값.
//   force=true 면 캐시를 무시하고 다시 스캔한다(게임 재시작 후 버전이 바뀌었을 때).
export function getGameDatecode(force = false): string | null {
  if (_cache && !force) return _cache.datecode;
  const found = scanDatecode();
  if (found) {
    _cache = { datecode: found, at: Date.now() };
    return found;
  }
  return _cache?.datecode ?? null;
}

// 캐시 없이 "지금 게임이 떠 있는지" 기준으로만 확인 (진단용).
export function probeGameDatecode(): string | null {
  return scanDatecode();
}
