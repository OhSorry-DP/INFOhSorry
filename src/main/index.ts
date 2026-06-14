import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import { join } from 'path';
import { readTsv } from './tsv';
import {
  findInfinitas,
  closeHandle,
  scanString,
  scanForPointer,
  scanForPointersInRange,
  listAllModules,
  findModuleContaining,
  readBytes,
  readPointer,
  decodeString,
  encodeString,
  type StringEncoding,
} from './memory';
import { RefluxManager, readRefluxOffsets } from './reflux';
import { getRemoteProfileOffsets } from './offsetsRemote';
import {
  getEreterData,
  getCacheStatus as getEreterCacheStatus,
  getDataPath as getEreterDataPath,
} from './ereter';
import { getZasaData, getCacheStatus as getZasaCacheStatus } from './zasa';
import { getSpTierData, getCacheStatus as getSpTierCacheStatus } from './spTier';
import { getRatingData, getRatingCacheStatus } from './rating';
import { fetchServiceStatus } from './serviceStatus';
import { downloadPortable, runPortable, cleanupOldPortables } from './portableUpdate';
import { checkForUpdate } from './updateCheck';
import { startHttpServer } from './http-server';

let mainWindow: BrowserWindow | null = null;
const refluxManager = new RefluxManager();

// 원격모드(LAN 로컬보드) — renderer 가 계산해 push 한 오소리웹 user 객체(별값 + charts_json) 캐시.
//   http-server 의 GET /api/me 가 이 값을 노출 → 오소리웹 원격 카드가 supabase 대신 읽음.
let remoteUser: unknown = null;

// 모든 IPC handler 를 단일 map 에. ipcMain.handle + HTTP /api/ipc 둘 다 같은 함수.
// 시그니처: (...args) → Promise<any> | any. event 파라미터는 ipcMain.handle wrapper 에서 제거.
export const ipcHandlers: Record<string, (...args: never[]) => unknown> = {
  // Reflux
  'reflux:start': async () => {
    try {
      await refluxManager.startAll();
      return { ok: true, state: refluxManager.getState() };
    } catch (e) {
      return { ok: false, error: (e as Error).message, state: refluxManager.getState() };
    }
  },
  'reflux:state': async () => refluxManager.getState(),
  'reflux:stop': async () => {
    await refluxManager.stop();
    return { ok: true };
  },
  'reflux:tsvPath': async () => RefluxManager.tsvFilePath,

  // Image (캡처)
  'image:save': async (...args: never[]) => {
    const data = args[0] as ArrayBuffer | string;
    const defaultName = args[1] as string | undefined;
    try {
      const fs = await import('fs');
      const path = await import('path');
      const dir = app.getPath('downloads');
      await fs.promises.mkdir(dir, { recursive: true });
      const fileName = defaultName || `capture-${Date.now()}.png`;
      const filePath = path.join(dir, fileName);
      let buf: Buffer;
      if (typeof data === 'string') {
        const base64 = data.replace(/^data:image\/png;base64,/, '');
        buf = Buffer.from(base64, 'base64');
      } else {
        buf = Buffer.from(data);
      }
      await fs.promises.writeFile(filePath, buf);
      return { ok: true, path: filePath };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // ereter
  'ereter:get': async (...args: never[]) => {
    const force = (args[0] as boolean | undefined) ?? false;
    try {
      const data = await getEreterData(force);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  'ereter:status': async () => getEreterCacheStatus(),
  'ereter:dataPath': async () => getEreterDataPath(),

  // ohSorryRating (ereter 미등록 lv11/lv12 차트 추정값 — 추천 풀 fallback)
  'rating:get': async (...args: never[]) => {
    const force = (args[0] as boolean | undefined) ?? false;
    try {
      const data = await getRatingData(force);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  'rating:status': async () => getRatingCacheStatus(),

  // gist offsets.json 의 프로필 메모리 offset — useProfile 이 기본값으로 사용 (없으면 profileOffsets.ts 상수 fallback)
  'offsets:getProfile': async () => getRemoteProfileOffsets(),

  // GitHub 최신 릴리즈 체크 — "v0.0.X 있음 → 다운로드" 알림용 (자동 다운로드 X)
  'update:check': async () => checkForUpdate(),

  // zasa (보충용 ☆12 난이도표 — DP12 격자 표 미분류 곡 fallback 매칭)
  'zasa:get': async (...args: never[]) => {
    const force = (args[0] as boolean | undefined) ?? false;
    try {
      const data = await getZasaData(force);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  'zasa:status': async () => getZasaCacheStatus(),

  // SP ☆12 서열표 (외부 구글 시트 ☆12参考表 하드/노마게 간이표) — published HTML fetch + 캐시
  'sptier:get': async (...args: never[]) => {
    const force = (args[0] as boolean | undefined) ?? false;
    try {
      const data = await getSpTierData(force);
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  'sptier:status': async () => getSpTierCacheStatus(),

  // 원격 service status (gist 의 service-status.json — uploadEnabled / shelfEnabled toggle).
  // main 에서 fetch (Node) — renderer 의 Chromium CORS 정책 우회. 매 호출 fresh fetch, fail-closed.
  'serviceStatus:get': async () => fetchServiceStatus(),

  // TSV
  'tsv:read': async (...args: never[]) => {
    const path = args[0] as string;
    try {
      const { rows, headerCols, mtime } = await readTsv(path);
      return { ok: true, rows, headerColCount: headerCols.length, mtime };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  // tsv 파일 내용 비우기 (truncate 0 bytes) — IIDXID 가 있었다가 사라지는 transition (= 게임 종료 후
  // 다른 ID 로 로그인) 시 옛 ID 의 데이터가 새 ID 로 잘못 올라가지 않도록 즉시 비움. 파일 없으면 graceful.
  //   - 파일 자체는 유지 → Reflux 의 watch handle 끊김 / 새 파일 생성 race 회피
  //   - readTsv 가 빈 rows 반환 → setRows([]) → upload skip
  //   - Reflux 가 다음 dump 시 정상 write
  // 옛 이름 'tsv:delete' 에서 의미상 정확한 'tsv:clear' 로 rename.
  'tsv:clear': async (...args: never[]) => {
    const path = args[0] as string;
    if (!path) return { ok: false, error: 'path 누락' };
    try {
      const fs = await import('fs');
      try {
        await fs.promises.truncate(path, 0);
        console.log(`[tsv:clear] 비우기 완료 → ${path}`);
        return { ok: true, cleared: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ok: true, cleared: false };  // 이미 없음 — 정상 케이스로 취급
        }
        throw e;
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  // 창 컨트롤 (frameless 모드 — 커스텀 헤더 버튼에서 호출)
  'window:minimize': async () => {
    mainWindow?.minimize();
    return { ok: true };
  },
  'window:maximize-toggle': async () => {
    if (!mainWindow) return { ok: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  },
  'window:close': async () => {
    mainWindow?.close();
    return { ok: true };
  },
  'window:isMaximized': async () => mainWindow?.isMaximized() ?? false,

  // 폴더 열기 (저장된 캡처 파일 위치 보여주기)
  'shell:showInFolder': async (...args: never[]) => {
    const path = args[0] as string;
    if (!path) return { ok: false };
    shell.showItemInFolder(path);
    return { ok: true };
  },

  // Reflux offsets.txt 파싱 — anchor (playData 등) 의 현재 module-base 기준 상대 offset 반환
  // 게임 패치로 Reflux 가 offsets.txt 갱신되면 자동 반영
  'reflux:offsets': async () => {
    const r = await readRefluxOffsets();
    if (!r) return { ok: false, error: 'offsets.txt 없음 (Reflux 한 번이라도 실행 후 다시 시도)' };
    // bigint → string (JSON 호환)
    const entries: Record<string, string> = {};
    const relative: Record<string, string> = {};
    for (const k of Object.keys(r.entries)) entries[k] = r.entries[k].toString();
    for (const k of Object.keys(r.relative)) relative[k] = r.relative[k].toString();
    return { ok: true, version: r.version, entries, relative, mtime: r.mtime };
  },

  // 메모리 스캔 — INFINITAS 프로세스에서 주어진 문자열 (UTF-16LE + ASCII 둘 다)
  // 검색해서 매칭되는 모든 절대 주소 + module base 기준 상대 offset 반환
  // ASLR 대응 — 다음 실행에선 새 base + 저장된 offset 으로 읽음
  'memory:scan': async (...args: never[]) => {
    const exeName = (args[0] as string) || 'bm2dx.exe';
    const text = args[1] as string;
    if (!text) return { ok: false, error: '검색할 문자열이 비어있음' };
    const found = findInfinitas(exeName);
    if (!found) {
      return { ok: false, error: `프로세스 "${exeName}" 못 찾음 (게임 실행 중인지 확인)` };
    }
    try {
      const results = scanString(found.handle, text);
      const flat = results.flatMap((r) =>
        r.matches.map((abs) => ({
          encoding: r.encoding,
          absolute: '0x' + abs.toString(16),
          // base 기준 상대 offset (음수 가능 — 모듈 밖 메모리)
          relative:
            (abs >= found.modBaseAddr ? '+0x' : '-0x') +
            (abs >= found.modBaseAddr
              ? abs - found.modBaseAddr
              : found.modBaseAddr - abs
            ).toString(16),
          // bigint 직렬화 어려워서 string 으로
          relativeRaw:
            abs >= found.modBaseAddr
              ? (abs - found.modBaseAddr).toString()
              : '-' + (found.modBaseAddr - abs).toString(),
        })),
      );
      return {
        ok: true,
        modBase: '0x' + found.modBaseAddr.toString(16),
        modSize: found.modBaseSize,
        results: flat,
      };
    } finally {
      closeHandle(found.handle);
    }
  },

  // refine scan — 이전 매치 목록의 각 주소에서 새 값과 일치하는 것만 keep (Cheat Engine 의 next scan).
  // 동작:
  //   1. 새 text 가 빈 문자열 ("") 이면: 인코딩별 첫 char size 만큼 read 해서 NULL byte 면 keep
  //      (= 그 주소가 디코딩 시 빈 문자열로 나오는 매치만 — "현재는 안 보이는 상태")
  //   2. 새 text 가 있으면: encode 한 byte 와 정확히 일치하는 것만 keep
  // 화면 바꿔 값이 변할 때 같은 위치의 새 값으로 좁힐 때 유용.
  'memory:refine-scan': async (...args: never[]) => {
    const exeName = (args[0] as string) || 'bm2dx.exe';
    const text = (args[1] as string) ?? '';
    const prev = args[2] as Array<{ encoding: StringEncoding; absolute: string }>;
    if (!Array.isArray(prev) || prev.length === 0) {
      return { ok: false, error: '이전 매치 목록 없음' };
    }
    const found = findInfinitas(exeName);
    if (!found) {
      return { ok: false, error: `프로세스 "${exeName}" 못 찾음 (게임 실행 중인지 확인)` };
    }
    try {
      // 빈 문자열 검색은 NULL 매치 (인코딩별 첫 char 가 0x00) 확인
      const isEmptySearch = text === '';
      // encoding 별 needle (encoded bytes 또는 NULL probe size) 미리 계산
      const needleByEnc = new Map<StringEncoding, Buffer>();
      const nullSizeByEnc: Record<StringEncoding, number> = {
        utf16le: 2,
        utf8: 1,
        ascii: 1,
        shiftjis: 1,
      };
      const kept: Array<{ encoding: StringEncoding; absolute: string }> = [];
      for (const m of prev) {
        try {
          const addr = BigInt(m.absolute);
          if (isEmptySearch) {
            const size = nullSizeByEnc[m.encoding] ?? 1;
            const actual = readBytes(found.handle, addr, size);
            // 첫 char 가 모두 NULL byte 면 디코딩 시 "" → keep
            if (actual.every((b) => b === 0)) kept.push(m);
          } else {
            let needle = needleByEnc.get(m.encoding);
            if (!needle) {
              needle = encodeString(text, m.encoding);
              needleByEnc.set(m.encoding, needle);
            }
            const actual = readBytes(found.handle, addr, needle.length);
            if (actual.equals(needle)) kept.push(m);
          }
        } catch {
          // 읽기 실패 (메모리 unmap 등) → drop
        }
      }
      const flat = kept.map((m) => {
        const abs = BigInt(m.absolute);
        const isAbove = abs >= found.modBaseAddr;
        const diff = isAbove ? abs - found.modBaseAddr : found.modBaseAddr - abs;
        return {
          encoding: m.encoding,
          absolute: m.absolute,
          relative: (isAbove ? '+0x' : '-0x') + diff.toString(16),
          relativeRaw: isAbove ? diff.toString() : '-' + diff.toString(),
        };
      });
      return {
        ok: true,
        modBase: '0x' + found.modBaseAddr.toString(16),
        modSize: found.modBaseSize,
        results: flat,
      };
    } finally {
      closeHandle(found.handle);
    }
  },

  // 주어진 heap 주소를 가리키는 static pointer 들 찾기 + 가장 가까운 Reflux anchor 와의 delta 계산.
  // 1차: 직접 매칭 (pointer value == heapAddr) — 이상적 케이스, valueOffset = 0
  // 2차 (fallback): pointer 가 [heapAddr - 0x1000, heapAddr] 범위 (struct base) 를 가리킴
  //   → valueOffset = heapAddr - pointerTarget = struct 안의 string 위치
  // 저장된 (anchor, delta, valueOffset) 로 다음 실행에서 자동 따라감
  'memory:find-anchor': async (...args: never[]) => {
    const exeName = (args[0] as string) || 'bm2dx.exe';
    const heapAddrStr = args[1] as string;
    if (!heapAddrStr) return { ok: false, error: 'heap address 비어있음' };
    const found = findInfinitas(exeName);
    if (!found) return { ok: false, error: '프로세스 못 찾음' };
    try {
      const heapAddr = BigInt(heapAddrStr);

      // 1차: 직접 매칭
      const directPtrs = scanForPointer(
        found.handle,
        found.modBaseAddr,
        found.modBaseSize,
        heapAddr,
      );
      // (ptr 위치, struct base = ptr 가리키는 값, valueOffset = heapAddr - struct base)
      let pointerHits: { ptrAddr: bigint; targetValue: bigint; valueOffset: bigint }[] =
        directPtrs.map((p) => ({ ptrAddr: p, targetValue: heapAddr, valueOffset: 0n }));

      // 2차: 직접 매칭 0개면 struct base 추정 (앞 4096 바이트까지 거슬러)
      if (pointerHits.length === 0) {
        const STRUCT_LOOKBACK = 0x1000n;
        const ranged = scanForPointersInRange(
          found.handle,
          found.modBaseAddr,
          found.modBaseSize,
          heapAddr - STRUCT_LOOKBACK,
          heapAddr,
        );
        pointerHits = ranged.map((r) => ({
          ptrAddr: r.ptrAddr,
          targetValue: r.targetValue,
          valueOffset: heapAddr - r.targetValue,
        }));
      }

      if (pointerHits.length === 0) {
        return {
          ok: false,
          error:
            '정적 영역에서 이 heap 주소 (또는 그 근처 4KB) 를 가리키는 pointer 못 찾음. 다른 매칭으로 시도해주세요',
        };
      }

      // Reflux offsets 로드 → 가장 가까운 anchor 와 delta 계산
      const refluxOff = await readRefluxOffsets();
      const candidates = pointerHits.map((h) => {
        const ptrRel = h.ptrAddr - found.modBaseAddr;
        let bestAnchor: { name: string; delta: bigint } | null = null;
        if (refluxOff) {
          for (const [name, anchorRel] of Object.entries(refluxOff.relative)) {
            const delta = ptrRel - anchorRel;
            if (
              !bestAnchor ||
              (delta < 0n ? -delta : delta) <
                (bestAnchor.delta < 0n ? -bestAnchor.delta : bestAnchor.delta)
            ) {
              bestAnchor = { name, delta };
            }
          }
        }
        return {
          pointerAbs: '0x' + h.ptrAddr.toString(16),
          pointerRel: ptrRel.toString(),
          anchorName: bestAnchor?.name ?? null,
          anchorDelta: bestAnchor?.delta.toString() ?? null,
          valueOffset: h.valueOffset.toString(), // struct base → string 안의 위치
        };
      });

      return {
        ok: true,
        modBase: '0x' + found.modBaseAddr.toString(16),
        candidates,
        refluxVersion: refluxOff?.version ?? null,
        // 디버그용: 직접 매칭 / 범위 매칭 각각 몇 개였나
        directHits: directPtrs.length,
      };
    } finally {
      closeHandle(found.handle);
    }
  },

  // 저장된 (anchor, delta, valueOffset) 로 string 읽기:
  //   1. modBase + (anchor 의 현재 relative) + delta = static pointer 위치
  //   2. *pointer = struct base (heap)
  //   3. struct base + valueOffset = string 시작 위치
  //   4. 그 위치에서 encoding 에 맞춰 read
  'memory:read-via-anchor': async (...args: never[]) => {
    const exeName = (args[0] as string) || 'bm2dx.exe';
    const anchorName = args[1] as string;
    const deltaStr = args[2] as string;
    const encoding = (args[3] as 'utf16le' | 'ascii') || 'utf16le';
    const maxBytes = (args[4] as number) || 64;
    const valueOffsetStr = (args[5] as string) || '0';
    const refluxOff = await readRefluxOffsets();
    if (!refluxOff || !(anchorName in refluxOff.relative)) {
      return { ok: false, error: `Reflux offsets 에 "${anchorName}" 없음` };
    }
    const found = findInfinitas(exeName);
    if (!found) return { ok: false, error: '프로세스 못 찾음' };
    try {
      const anchorRel = refluxOff.relative[anchorName];
      const delta = BigInt(deltaStr);
      const valueOffset = BigInt(valueOffsetStr);
      const pointerLoc = found.modBaseAddr + anchorRel + delta;
      const structBase = readPointer(found.handle, pointerLoc);
      if (structBase === 0n) return { ok: false, error: 'pointer 가 null' };
      const valueAddr = structBase + valueOffset;
      const buf = readBytes(found.handle, valueAddr, maxBytes);
      const text = decodeString(buf, encoding as StringEncoding);
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      closeHandle(found.handle);
    }
  },

  // 저장된 offset 으로 문자열 읽기 — module base 다시 찾고 + offset 더해서 read
  'memory:read-string': async (...args: never[]) => {
    const exeName = (args[0] as string) || 'bm2dx.exe';
    const relativeOffset = args[1] as string; // bigint string
    const encoding = (args[2] as StringEncoding) || 'utf16le';
    const maxBytes = (args[3] as number) || 64;
    const found = findInfinitas(exeName);
    if (!found) return { ok: false, error: '프로세스 못 찾음' };
    try {
      const offset = BigInt(relativeOffset);
      const addr = found.modBaseAddr + offset;
      const buf = readBytes(found.handle, addr, maxBytes);
      const text = decodeString(buf, encoding);
      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      closeHandle(found.handle);
    }
  },

  // 진단
  'memory:probe': async (...args: never[]) => {
    const exeName = args[0] as string;
    try {
      const found = findInfinitas(exeName);
      if (!found) {
        return { ok: false, error: `프로세스 "${exeName}" 못 찾음 (게임 실행 중인지 확인)` };
      }
      try {
        return {
          ok: true,
          pid: found.pid,
          modBaseAddr: '0x' + found.modBaseAddr.toString(16),
          modBaseSize: found.modBaseSize,
          modName: found.modName,
        };
      } finally {
        closeHandle(found.handle);
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  // 원격모드 — renderer 가 user 객체(별값 + charts_json)를 계산해 push. http-server /api/me 가 노출.
  'remote:setUser': (user: unknown) => {
    remoteUser = user;
    return { ok: true };
  },
};

// ipcMain 등록 (electron renderer 용)
for (const [channel, fn] of Object.entries(ipcHandlers)) {
  ipcMain.handle(channel, async (_evt, ...args) => (fn as (...a: unknown[]) => unknown)(...args));
}

// 포터블 자동 다운로드 + 실행 (v0.0.19+) — event.sender 가 필요해서 별도 등록
ipcMain.handle('portable:download', async (e, payload: { url: string; fileName: string }) => {
  return downloadPortable(payload.url, payload.fileName, e.sender);
});
ipcMain.handle('portable:run', async (_e, filePath: string) => {
  return runPortable(filePath);
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 520, // 그 이하에선 헤더 / 탭 / 추천 패널 레이아웃이 깨짐
    minHeight: 400,
    title: 'ohSorryScoreINF',
    icon: join(__dirname, '../../ohsorry.ico'),
    frame: false,  // 프레임리스 — 헤더에 커스텀 close/min/max 버튼 사용
    roundedCorners: false,  // Windows 11 기본 라운드 코너 비활성
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  // 창 상태 변화 → renderer 에 알림 (max ↔ restore 아이콘 토글용)
  const emitMaxState = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', emitMaxState);
  mainWindow.on('unmaximize', emitMaxState);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // prod 에서도 사용자가 devtools 열 수 있게 — Ctrl+Shift+I 로 toggle.
  // (F12 는 INFINITAS 등 다른 곳과 충돌 우려로 등록 안 함.)
  // (Menu.setApplicationMenu(null) 이라 메뉴는 없지만 키보드 단축키만 처리.)
  // window 자체의 input event 라 INFOhSorry 창 포커스 시에만 동작 (globalShortcut 아님).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow?.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  refluxManager.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('reflux:state', state);
    }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

  // 자기 실행 파일이 portable 패턴이면 같은 폴더 내 옛 portable 정리 (자기 패턴만, 안전)
  const cl = cleanupOldPortables();
  if (cl.removed.length > 0) console.log('[portable cleanup] removed:', cl.removed);
  if (cl.errors.length > 0) console.warn('[portable cleanup] errors:', cl.errors);

  // production 빌드에서만 HTTP 서버 시작 (LAN 모드 — 다른 PC 의 Chrome 으로 접속해서 동일 화면 + 원격 제어)
  if (!process.env.ELECTRON_RENDERER_URL) {
    const rendererDir = join(__dirname, '../renderer');
    try {
      startHttpServer(refluxManager, rendererDir, ipcHandlers, () => remoteUser, join(app.getPath('userData'), 'osr-cache'));
    } catch (e) {
      console.warn('[http] 서버 시작 실패:', (e as Error).message);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  void (async () => {
    const status = getEreterCacheStatus();
    if (status.isStale) {
      try {
        await getEreterData(false);
        console.log('[ereter] 자동 갱신 완료');
      } catch (e) {
        console.warn('[ereter] 자동 갱신 실패:', (e as Error).message);
      }
    }
  })();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (refluxManager.getState().spawned) {
    e.preventDefault();
    try {
      await refluxManager.stop();
    } catch {
      /* ignore */
    }
    app.exit(0);
  }
});
