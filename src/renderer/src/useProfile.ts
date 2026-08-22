// useProfile — INFINITAS 메모리에서 DJ NAME / IIDX ID / 노트레이더 / 단위 읽기.
//   사용자 저장값 (MemoryScanner 로 저장) 우선, 없으면 PROFILE_OFFSETS 기본값.
//   refluxState 가 ready / hooked 일 때 (게임 메모리 가용) polling.
//
// 문자열(djName/iidxId) 과 숫자(레이더 12개 / 단위 2개) 는 읽는 경로가 다르다:
//   문자열 = memory.readString (인코딩별 디코드), 숫자 = memory.readInts (int32 배열).
//
// 브라우저 원격 (PC2) 에서도 IPC bridge 로 호출됨 → host 쪽 INFINITAS 메모리 read.
import { useEffect, useRef, useState } from 'react';
import {
  PROFILE_OFFSETS,
  PROFILE_NUMERIC_OFFSETS,
  RADAR_AXIS_ORDER,
  DAN_NAMES,
  danIndexToRankInt,
  isRemoteNumericOffset,
  isRemoteStringOffset,
  type RemoteProfileMap,
  type StringEncoding,
} from '../../shared/profileOffsets';
import type { RadarValues } from './NotesRadar';
import type { RefluxState } from '../../shared/types';

// gist offsets.json 의 profile 부분 (main IPC offsets:getProfile). 없으면 null → 코드 상수 fallback.
//   값이 null 인 필드 = "이 게임 빌드에서는 그 주소를 아직 모른다". 키가 아예 없는 것(정보 없음)과
//   구분해서, null 이면 옛 빌드 상수로 fallback 하지 않고 읽기를 건너뛴다.
//   문자열 필드({offset,encoding,maxBytes})와 숫자 필드({offset,count,scale})가 같은 맵에 섞여 온다.
type RemoteProfile = RemoteProfileMap | null;

// gist profile offsets 모듈 캐시 — hook 이 마운트 시 채우고, hook 밖(업로드 재검증)에서도 참조한다.
//   아직 안 채워졌으면 null → PROFILE_OFFSETS 코드 상수 fallback (hook 의 초기 동작과 동일).
let cachedRemoteProfile: RemoteProfile = null;

const EXE_NAME = 'bm2dx.exe';
const POLL_INTERVAL_MS = 5000;

type FieldKey = 'djName' | 'iidxId' | 'spRank' | 'dpRank';
const STORAGE_KEY: Record<FieldKey, string> = {
  djName: 'infohsorry-scanner-djname-v2',
  iidxId: 'infohsorry-scanner-iidxid-v2',
  spRank: 'infohsorry-scanner-sprank-v2',
  dpRank: 'infohsorry-scanner-dprank-v2',
};

interface SavedAnchor {
  mode: 'anchor';
  anchor: string;
  delta: string;
  valueOffset: string;
  encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis';
}
interface SavedDirect {
  mode: 'direct';
  offset: string;
  encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis';
  isStatic: boolean;
}
type SavedSlot = SavedAnchor | SavedDirect;

function loadSaved(key: FieldKey): SavedSlot | null {
  const raw = localStorage.getItem(STORAGE_KEY[key]);
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<SavedSlot> & { mode?: string };
    if (j.mode === 'anchor' && j.anchor && j.delta && j.encoding) {
      return {
        mode: 'anchor',
        anchor: j.anchor,
        delta: j.delta,
        valueOffset: (j as { valueOffset?: string }).valueOffset || '0',
        encoding: j.encoding,
      };
    }
    if (j.mode === 'direct' && (j as { offset?: string }).offset && j.encoding) {
      return {
        mode: 'direct',
        offset: (j as { offset: string }).offset,
        encoding: j.encoding,
        isStatic: !!(j as { isStatic?: boolean }).isStatic,
      };
    }
  } catch {}
  return null;
}

// 기본 offset 정의 — gist(remote) 우선, 없으면 코드 상수(PROFILE_OFFSETS) fallback.
function pickDef(
  key: FieldKey,
  remote: RemoteProfile,
): { offset: string; encoding: StringEncoding; maxBytes: number } | undefined {
  // 이 빌드에서 주소 미상(null)으로 표기된 필드는 읽지 않는다 — 옛 빌드 주소로 엉뚱한 메모리를
  //   읽어 쓰레기 문자열을 표시하느니 비워두는 편이 낫다. (단위는 Supabase 로 보강되기도 한다.)
  if (remote && key in remote && remote[key] === null) return undefined;
  const r = remote?.[key];
  if (isRemoteStringOffset(r)) {
    return { offset: r.offset, encoding: r.encoding as StringEncoding, maxBytes: r.maxBytes ?? 64 };
  }
  const def = PROFILE_OFFSETS[key];
  if (def) return { offset: def.offset, encoding: def.encoding, maxBytes: def.maxBytes };
  return undefined;
}

// 숫자 필드(radar/dan) 의 offset — 문자열 필드와 같은 우선순위 규칙 (gist > 코드 상수, null 이면 skip).
//   MemoryScanner 는 문자열 전용이라 사용자 저장 슬롯 개념이 없다.
type NumericKey = 'radar' | 'dan';
export function pickNumericDef(
  key: NumericKey,
  remote: RemoteProfile,
): { offset: string; count: number; scale?: number } | undefined {
  if (remote && key in remote && remote[key] === null) return undefined;
  const r = remote?.[key];
  // gist 값이 있으면 우선. 모양이 깨졌으면(가드 실패) 무시하고 코드 상수로 — 엉뚱한 주소를 읽지 않기 위해.
  if (isRemoteNumericOffset(r)) return { offset: r.offset, count: r.count, scale: r.scale };
  const def = PROFILE_NUMERIC_OFFSETS[key];
  if (def) return { offset: def.offset, count: def.count, scale: def.scale };
  return undefined;
}

async function readNumeric(key: NumericKey, remote: RemoteProfile): Promise<number[] | null> {
  const def = pickNumericDef(key, remote);
  if (!def) return null;
  const r = await window.infohsorry.memory.readInts(
    EXE_NAME,
    BigInt(def.offset).toString(),
    def.count,
  );
  if (!r.ok || !r.values || r.values.length < def.count) return null;
  return r.values;
}

// 레이더 12개 int32 → SP / DP 값 객체. offset 이 어긋났거나 아직 안 채워진 상태면 null.
//   유효 범위 — 지표 하나는 0 ~ 600.00 (raw 0~60000). 밖으로 나가면 엉뚱한 메모리로 보고 통째 버린다.
//   한쪽 플레이 스타일만 하는 유저는 그쪽 6개가 전부 0 → 그 스타일만 null.
export function parseRadarBlock(
  values: number[] | null,
  scale = 100,
): { sp: RadarValues | null; dp: RadarValues | null } | null {
  if (!values || values.length < 12) return null;
  const raw = values.slice(0, 12);
  if (raw.some((v) => !Number.isInteger(v) || v < 0 || v > 60000)) return null;
  if (raw.every((v) => v === 0)) return null; // 로그인 전 — 아직 서버 데이터 미수신
  const div = scale && scale > 0 ? scale : 100;
  const sp = {} as RadarValues;
  const dp = {} as RadarValues;
  RADAR_AXIS_ORDER.forEach((axis, i) => {
    sp[axis] = raw[i * 2] / div;
    dp[axis] = raw[i * 2 + 1] / div;
  });
  const hasAny = (r: RadarValues): boolean => RADAR_AXIS_ORDER.some((a) => (r[a] ?? 0) > 0);
  return { sp: hasAny(sp) ? sp : null, dp: hasAny(dp) ? dp : null };
}

// 단위 [SP, DP] int32 → 게임 index. -1 = 미취득, 범위 밖 = 못 읽은 것으로 간주(null).
export function parseDanBlock(values: number[] | null): { sp: number | null; dp: number | null } {
  if (!values || values.length < 2) return { sp: null, dp: null };
  const pick = (v: number): number | null =>
    Number.isInteger(v) && v >= -1 && v < DAN_NAMES.length ? v : null;
  return { sp: pick(values[0]), dp: pick(values[1]) };
}

function effective(key: FieldKey, remote: RemoteProfile): SavedSlot | null {
  const saved = loadSaved(key);
  if (saved) return saved;
  const def = pickDef(key, remote);
  if (!def) return null; // 사용자 저장도, gist 도, 코드 상수도 없음
  return {
    mode: 'direct',
    offset: BigInt(def.offset).toString(),
    encoding: def.encoding,
    isStatic: true,
  };
}

interface ReadFieldResult {
  value: string | null;
  processMissing: boolean;
  error?: string;
}

async function readField(key: FieldKey, remote: RemoteProfile): Promise<ReadFieldResult> {
  const slot = effective(key, remote);
  if (!slot) return { value: null, processMissing: false, error: '프로필 offset 없음' };
  const maxBytes = pickDef(key, remote)?.maxBytes ?? 64;
  const r =
    slot.mode === 'anchor'
      ? await window.infohsorry.memory.readViaAnchor(
          EXE_NAME,
          slot.anchor,
          slot.delta,
          slot.encoding,
          maxBytes,
          slot.valueOffset,
        )
      : await window.infohsorry.memory.readString(EXE_NAME, slot.offset, slot.encoding, maxBytes);
  if (!r.ok || !r.text) return { value: null, processMissing: r.processMissing ?? false, error: r.error };
  // null / 비정상 문자 trim — ascii 의 경우 0x20 미만은 제어문자
  let t = r.text;
  if (slot.encoding === 'ascii') {
    t = t.replace(/[\x00-\x1f\x7f-\xff]+/g, '').trim();
  } else {
    t = t.replace(/\x00/g, '').trim();
  }
  return { value: t || null, processMissing: false };
}

// 업로드 직전 재검증용 — React state 를 거치지 않고 그 순간의 메모리에서 IIDX ID 를 직접 읽는다.
//   processMissing = 게임이 이미 종료됨(정상 상황). 호출부가 fail-open/closed 를 판단한다.
export async function readIidxIdFresh(): Promise<{
  ok: boolean;
  iidxId: string | null;
  processMissing: boolean;
  error?: string;
}> {
  // 예외를 밖으로 흘리지 않는다 — 호출부(tryUpload)가 await 하는데 여기서 reject 되면
  //   final 트리거에서 upload.finalDone() 까지 못 가 main 이 6초 타임아웃을 기다리고
  //   마지막 플레이 업로드가 통째로 유실된다. 실패는 ok:false 로만 표현한다.
  try {
    const result = await readField('iidxId', cachedRemoteProfile);
    return {
      ok: result.value != null,
      iidxId: result.value,
      processMissing: result.processMissing,
      error: result.error,
    };
  } catch (e) {
    return {
      ok: false,
      iidxId: null,
      processMissing: false,
      error: (e as Error)?.message ?? String(e),
    };
  }
}

export interface ProfileInfo {
  djName: string | null;
  iidxId: string | null;
  // IIDX ID 가 하이픈 없는 13자라면 "C-NNNN-NNNN-NNNN" 형식으로 변환
  iidxIdFormatted: string | null;
  // 단위 표기 (十段 등). 미취득(-1) / 못 읽음 → null.
  spRank: string | null;
  dpRank: string | null;
  // supabase users.sp_rank/dp_rank 와 같은 int 스케일 (12=皆伝 … 0=一級 … -8=九級). 미취득/미확인 → null.
  spRankInt: number | null;
  dpRankInt: number | null;
  // 노트레이더 6지표 (실수값, 예: 92.34). 해당 스타일 데이터 없으면 null.
  spRadar: RadarValues | null;
  dpRadar: RadarValues | null;
}

export function useProfile(refluxState: RefluxState): ProfileInfo {
  const [djName, setDjName] = useState<string | null>(null);
  const [iidxId, setIidxId] = useState<string | null>(null);
  // 단위 — 메모리의 정수 index (-1 = 미취득). 사용자가 MemoryScanner 로 저장한 문자열 슬롯이 있으면
  //   그 문자열이 우선 (legacy 호환, 아래 legacySpRank/legacyDpRank).
  const [spDan, setSpDan] = useState<number | null>(null);
  const [dpDan, setDpDan] = useState<number | null>(null);
  const [legacySpRank, setLegacySpRank] = useState<string | null>(null);
  const [legacyDpRank, setLegacyDpRank] = useState<string | null>(null);
  // 노트레이더 — JSON 문자열로 비교해서 값이 같으면 setState 를 건너뛴다 (매 poll 리렌더 방지).
  const [radar, setRadar] = useState<{ sp: RadarValues | null; dp: RadarValues | null } | null>(
    null,
  );
  const radarJsonRef = useRef<string>('null');

  // gist offsets.json 의 profile offset — 마운트 1회 fetch. ref 라 polling tick 이 항상 최신값 참조.
  const remoteRef = useRef<RemoteProfile>(null);
  useEffect(() => {
    let alive = true;
    window.infohsorry?.offsets
      ?.getProfile?.()
      .then((r) => {
        // main 이 게임 datecode 로 고른 build 의 profile — 빌드가 안 맞으면 main 이 이미 경고를 남긴다.
        if (alive && r) {
          remoteRef.current = r.profile ?? null;
          cachedRemoteProfile = r.profile ?? null;
        }
      })
      .catch(() => {
        /* gist 실패 — 코드 상수 fallback */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    // Reflux 재spawn (게임 재시작 후 / 재실행) 감지 시 profile state 초기화 — 옛 값 sticky 방지.
    // starting / idle / downloading 으로 들어오면 곧 새 INFINITAS 메모리로 read 할 거니까 일단 null 리셋.
    const stageNow = refluxState.stage;
    if (stageNow === 'idle' || stageNow === 'starting' || stageNow === 'downloading') {
      setDjName(null);
      setIidxId(null);
      setSpDan(null);
      setDpDan(null);
      setLegacySpRank(null);
      setLegacyDpRank(null);
      setRadar(null);
      radarJsonRef.current = 'null';
    }
    const tick = async (): Promise<void> => {
      if (!alive) return;
      const stage = refluxState.stage;
      if (stage === 'idle' || stage === 'error' || stage === 'downloading' || stage === 'starting') {
        if (alive) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }
      try {
        const remote = remoteRef.current;
        // 단위/레이더는 정수 블록 2번 read 로 끝난다 (문자열 필드처럼 인코딩별 시도 불필요).
        // 문자열 단위 슬롯은 사용자가 MemoryScanner 로 저장했을 때만 읽는다 (기본 offset 은 이제 없음).
        const [djR, idR, radarR, danR, legacySpR, legacyDpR] = await Promise.allSettled([
          readField('djName', remote),
          readField('iidxId', remote),
          readNumeric('radar', remote),
          readNumeric('dan', remote),
          loadSaved('spRank') ? readField('spRank', remote) : Promise.resolve({ value: null, processMissing: false }),
          loadSaved('dpRank') ? readField('dpRank', remote) : Promise.resolve({ value: null, processMissing: false }),
        ]);
        if (!alive) return;
        // stale closure 방지 — 이 effect 는 deps 가 [refluxState.stage] 뿐이라 djName 등 state 를
        //   생성 시점 값으로 캡처한다. 원시값의 동일 setState 는 React 가 bailout 한다.
        if (djR.status === 'fulfilled') setDjName(djR.value.value);
        else console.warn('[useProfile] djName 읽기 실패:', djR.reason);
        if (idR.status === 'fulfilled') setIidxId(idR.value.value);
        else console.warn('[useProfile] iidxId 읽기 실패:', idR.reason);
        if (danR.status === 'fulfilled') {
          const dan = parseDanBlock(danR.value);
          setSpDan(dan.sp);
          setDpDan(dan.dp);
        } else {
          console.warn('[useProfile] 단위 읽기 실패:', danR.reason);
        }
        if (legacySpR.status === 'fulfilled') setLegacySpRank(legacySpR.value.value);
        else console.warn('[useProfile] SP 단위 읽기 실패:', legacySpR.reason);
        if (legacyDpR.status === 'fulfilled') setLegacyDpRank(legacyDpR.value.value);
        else console.warn('[useProfile] DP 단위 읽기 실패:', legacyDpR.reason);
        // 레이더는 객체라 값이 같아도 매번 새 참조 → JSON 시그니처(ref) 로 비교해야 리렌더가 안 샌다.
        //   (이 effect 는 stage 에만 의존해서 state 를 stale 하게 캡처하므로 state 비교로는 안 된다.)
        if (radarR.status === 'fulfilled') {
          const nextRadar = parseRadarBlock(radarR.value, pickNumericDef('radar', remote)?.scale);
          const nextJson = JSON.stringify(nextRadar);
          if (nextJson !== radarJsonRef.current) {
            radarJsonRef.current = nextJson;
            setRadar(nextRadar);
          }
        } else {
          console.warn('[useProfile] 레이더 읽기 실패:', radarR.reason);
        }
      } catch (e) {
        // 다음 poll 에서 재시도 — 원인은 남긴다 (재현 진단용)
        console.warn('[useProfile] 프로필 폴링 실패:', (e as Error)?.message ?? e);
      }
      if (alive) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refluxState.stage]);

  const iidxIdFormatted =
    iidxId && /^[A-Z]\d{12}$/.test(iidxId)
      ? `${iidxId[0]}-${iidxId.slice(1, 5)}-${iidxId.slice(5, 9)}-${iidxId.slice(9, 13)}`
      : iidxId;

  // 표기 문자열 — 사용자 저장 슬롯(legacy) > 메모리 index. index -1(미취득) 은 null 로 두고
  //   "-" 표기는 표시 쪽(ProfileCard) 이 결정한다.
  const danName = (idx: number | null): string | null =>
    idx != null && idx >= 0 && idx < DAN_NAMES.length ? DAN_NAMES[idx] : null;

  return {
    djName,
    iidxId,
    iidxIdFormatted,
    spRank: legacySpRank ?? danName(spDan),
    dpRank: legacyDpRank ?? danName(dpDan),
    spRankInt: danIndexToRankInt(spDan),
    dpRankInt: danIndexToRankInt(dpDan),
    spRadar: radar?.sp ?? null,
    dpRadar: radar?.dp ?? null,
  };
}
