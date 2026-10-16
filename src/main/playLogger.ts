// 플레이 기록기 (런타임): 실행 중인 bm2dx.exe 메모리를 주기적으로 읽어서,
// 플레이 중 -> 결과 화면으로 바뀌는 순간에만 한 줄을 plays.csv 에 추가한다.
// 규칙과 열 정의: docs/play-logger.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { buildPlayErrorRow, PLAY_CSV_KEYS } from '../shared/uploadSnapshot';
import { dirname } from 'path';
import { accountPlayCsvPath } from './accountTsvStore';
import { closeHandle, findInfinitas, readBytes, type InfinitasHandle } from './memory';
import {
  PLAY_LOG_HEADER,
  PLAY_LOG_LAYOUT as L,
  PREFERRED_BASE,
  buildPlayRow,
  csvField,
  decideState,
  findMarkerDelta,
  lookupSongInBuffer,
  parseOffsetsText,
  resolvePlay,
  type PlayState,
} from './playLog';

const GAME_EXE = 'bm2dx.exe';
const TICK_ATTACHED_MS = 500;
const TICK_DETACHED_MS = 2000;
// 결과 화면 진입 후 값이 안정될 때까지 기다리는 시간
const RESULT_SETTLE_MS = 1500;

export interface PlayLoggerOptions {
  appVersion?: string;
  getGameVersion?: (handle: InfinitasHandle) => string | null;
  /** 저장 순간 게임 핸들에서 실제 계정을 확인한다. */
  getAccount: (handle: InfinitasHandle) => string | null;
  onAppend: (event: { iidxId: string }) => void;
  /** Reflux 가 쓰는 offsets.txt 경로 (songList, judgeData, playSettings, playData 를 여기서 읽는다) */
  offsetsPath: string;
  log: (line: string) => void;
}

interface Addresses {
  judge: bigint;
  playSettings: bigint;
  playData: bigint;
  songList: bigint;
  /** 배틀에서 곡 정보를 얻는 블록. offsets.txt 에 없으면 null (일반 플레이만 기록) */
  currentSong: bigint | null;
  marker: bigint | null;
}

function ints(handle: unknown, addr: bigint, n: number): number[] {
  const b = readBytes(handle, addr, n * 4);
  return Array.from({ length: n }, (_, i) => b.readInt32LE(i * 4));
}

// 플레이 기록기를 시작한다. 반환값은 정지 함수.
export function startPlayLogger(opts: PlayLoggerOptions): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let handle: InfinitasHandle | null = null;
  let addr: Addresses | null = null;
  let prev: PlayState | null = null;
  let busy = false;
  let pid: number | null = null;
  let versions = { appVersion: opts.appVersion ?? '', gameVersion: '' };
  const observed = new Set<string>();
  let fingerprint: { mtimeMs: number; size: number } | null = null;
  let attachedAt = 0;

  const account = (game: InfinitasHandle): string | null => {
    try {
      const id = opts.getAccount(game);
      return id && /^[A-Z]\d{12}$/.test(id) ? id : null;
    } catch { return null; }
  };
  const append = (iidxId: string, row: string): boolean => {
    try {
      const csvPath = accountPlayCsvPath(iidxId);
      if (!csvPath) throw new Error('Invalid account CSV path');
      mkdirSync(dirname(csvPath), { recursive: true });
      if (!existsSync(csvPath)) writeFileSync(csvPath, PLAY_LOG_HEADER + '\n', 'utf8');
      appendFileSync(csvPath, row + '\n', 'utf8');
    } catch (e) {
      diagnose(-4, iidxId, String(e));
      return false;
    }
    opts.onAppend({ iidxId });
    return true;
  };
  const diagnose = (code: number, iidxId: string | null, detail = ''): void => {
    const timestamp = new Date().toISOString();
    const key = `${pid}/${code}/${iidxId ?? '?'}`;
    if (observed.has(key) || observed.has(`${pid}/${code}/?`)) return;
    observed.add(key);
    opts.log(`[playlog] error ${code} pid=${pid} id=${iidxId ?? '?'} ${detail}`);
    if (code === -1 || code === -4 || !iidxId) return;
    const row = buildPlayErrorRow(code, versions, timestamp);
    append(iidxId, PLAY_CSV_KEYS.map(key => csvField(row[key])).join(','));
  };
  const sameFile = (a: { mtimeMs: number; size: number }, b: { mtimeMs: number; size: number }): boolean =>
    a.mtimeMs === b.mtimeMs && a.size === b.size;

  const detach = (): void => {
    try {
      if (handle) closeHandle(handle.handle);
    } catch {
      /* 이미 닫힌 핸들 */
    }
    handle = null;
    addr = null;
    prev = null;
    fingerprint = null;
    attachedAt = 0;
  };

  // 게임에 붙는다. offsets.txt 가 없거나 게임이 떠 있지 않으면 false
  const attach = (): boolean => {
    if (handle) return true;
    const found = findInfinitas(GAME_EXE);
    if (!found) {
      pid = null;
      observed.clear();
      return false;
    }
    try {
      if (pid !== found.pid) {
        pid = found.pid;
        observed.clear();
        versions = { appVersion: opts.appVersion ?? '', gameVersion: '' };
        try { versions.gameVersion = opts.getGameVersion?.(found) ?? ''; }
        catch (e) { opts.log(`[playlog] game version unavailable: ${String(e)}`); }
        if (!versions.appVersion || !versions.gameVersion) opts.log('[playlog] version unavailable');
      }
      let offs: ReturnType<typeof parseOffsetsText>;
      let before: ReturnType<typeof statSync>;
      let after: ReturnType<typeof statSync>;
      try {
        before = statSync(opts.offsetsPath);
        offs = parseOffsetsText(readFileSync(opts.offsetsPath, 'utf8'));
        after = statSync(opts.offsetsPath);
      } catch (e) {
        diagnose(-6, account(found), String(e));
        return false;
      }
      if (!sameFile(before, after)) return false;
      if (!offs.judgeData || !offs.playSettings || !offs.playData || !offs.songList) {
        diagnose(-7, account(found));
        return false;
      }
      // offsets.txt 의 절대주소(선호 베이스 기준) -> 지금 프로세스의 실제 주소
      const live = (abs: bigint) => found.modBaseAddr + (abs - PREFERRED_BASE);
      handle = found;
      addr = {
        judge: live(offs.judgeData),
        playSettings: live(offs.playSettings),
        playData: live(offs.playData),
        songList: live(offs.songList),
        currentSong: offs.currentSong ? live(offs.currentSong) : null,
        marker: null,
      };
      fingerprint = { mtimeMs: after.mtimeMs, size: after.size };
      attachedAt = performance.now();
      opts.log(`[playlog] attached pid ${found.pid}`);
      return true;
    } finally {
      if (handle !== found) closeHandle(found.handle);
    }
  };

  const currentState = (): PlayState => {
    const a = addr!;
    const h = handle!.handle;
    if (a.marker === null) {
      const scanAt = a.judge + BigInt(L.markerScanFromJudge);
      const d = findMarkerDelta(readBytes(h, scanAt, 96));
      if (d === null) {
        if (performance.now() - attachedAt >= 30000) diagnose(-5, account(handle!));
        return 'select';
      }
      a.marker = scanAt + BigInt(d);
    }
    const marker = readBytes(h, a.marker, 4).readInt32LE(0);
    const ps18 = readBytes(h, a.playSettings - BigInt(L.settingsStateDelta), 4).readInt32LE(0);
    return decideState(marker, ps18);
  };

  // 저장할 플레이가 없으면 null (PlayData 도 비고 배틀 보정도 불가능한 경우)
  const buildSnapshotRow = (): { row: string; songId: number; source: string } | null => {
    const a = addr!;
    const h = handle!.handle;
    const judge16 = ints(h, a.judge, 16);
    const p1Settings = ints(h, a.playSettings, L.settingsWords);
    const battle = p1Settings[L.battleFlagDelta / 4] === 1;
    const play = resolvePlay({
      playData: ints(h, a.playData, L.playDataWords),
      currentSong: a.currentSong ? ints(h, a.currentSong, L.currentSongWords) : new Array<number>(L.currentSongWords).fill(0),
      judge16,
      battle,
    });
    if (!play) return null;
    const songBuf = readBytes(h, a.songList, L.songCount * L.songStride);
    const song = lookupSongInBuffer(songBuf, play.songId, play.diff) ?? { title: '', notes: 0 };
    const gauge = ints(h, a.judge + BigInt(L.gaugeWordP1 * 4), 2);
    const row = buildPlayRow({
      timestamp: new Date().toISOString(),
      songId: play.songId,
      title: song.title,
      diff: play.diff,
      notes: play.currentNotes ?? song.notes,
      exScore: play.exScore,
      miss: play.miss,
      pgreat: play.pgreat,
      great: play.great,
      lamp: play.lamp,
      judge16,
      p1Settings,
      p2Settings: ints(h, a.playSettings + BigInt(L.p2SettingsDelta), L.settingsWords),
      gauge: [gauge[0], gauge[1]],
      source: play.source,
      ...versions,
    });
    return { row, songId: play.songId, source: play.source };
  };

  const saveOnce = (): void => {
    const iidxId = account(handle!);
    if (!iidxId) { diagnose(-1, null); return; }
    let snap: ReturnType<typeof buildSnapshotRow>;
    try { snap = buildSnapshotRow(); }
    catch (e) {
      opts.log(`[playlog] save failed: ${String(e)}`);
      diagnose(-3, iidxId, String(e));
      return;
    }
    if (!snap) {
      opts.log('[playlog] skipped: 저장할 플레이 정보가 없음 (PlayData·CurrentSong 모두 비어 있음)');
      diagnose(-2, iidxId);
      return;
    }
    if (append(iidxId, snap.row)) opts.log(`[playlog] saved play song_id=${snap.songId} source=${snap.source} -> ${accountPlayCsvPath(iidxId)}`);
  };

  const tick = (): void => {
    if (stopped) return;
    if (busy) return schedule();
    try {
      if (handle && fingerprint) {
        try {
          if (!sameFile(fingerprint, statSync(opts.offsetsPath))) detach();
        } catch { detach(); }
      }
      if (!attach()) {
        prev = null;
        return schedule();
      }
      const now = currentState();
      if (prev === 'playing' && now !== 'playing') {
        busy = true;
        setTimeout(() => {
          try {
            if (handle) saveOnce();
          } catch (e) {
            opts.log(`[playlog] save failed: ${String(e)}`);
          } finally {
            busy = false;
          }
        }, RESULT_SETTLE_MS);
      }
      prev = now;
    } catch (e) {
      // 게임 종료 등 읽기 실패: 붙어 있던 핸들을 버리고 다시 붙는다
      opts.log(`[playlog] detached: ${String(e)}`);
      detach();
    }
    schedule();
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(tick, handle ? TICK_ATTACHED_MS : TICK_DETACHED_MS);
  };

  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    detach();
  };
}
