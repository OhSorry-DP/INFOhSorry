import { contextBridge, ipcRenderer } from 'electron';
import type {
  ProbeResult,
  TsvReadResult,
  RefluxState,
  RefluxStartResult,
  EreterGetResult,
  EreterCacheStatus,
  ZasaGetResult,
  ZasaCacheStatus,
  SpTierGetResult,
  SpTierCacheStatus,
  ServiceStatus,
  RatingGetResult,
  RatingCacheStatus,
  UpdateInfo,
} from '../shared/types';
import type { InfinitasSessionState } from '../shared/session';
import type { AccountMeta, TsvChangedEvent, AccountSnapshotRequest, AccountSnapshotResult } from '../shared/account';
import type { RemoteProfileMap } from '../shared/profileOffsets';

const api = {
  // TSV 직접 읽기
  readTsv: (path: string): Promise<TsvReadResult> => ipcRenderer.invoke('tsv:read', path),
  // tsv 파일 내용 비우기 (truncate) — IIDXID 가 사라지는 transition 시 stale 데이터 자동 제거.
  //   파일은 유지 (Reflux watch handle 보존) + 내용만 0 bytes.
  clearTsv: (path: string): Promise<{ ok: boolean; cleared?: boolean; error?: string }> =>
    ipcRenderer.invoke('tsv:clear', path),

  // Reflux 관리
  reflux: {
    start: (): Promise<RefluxStartResult> => ipcRenderer.invoke('reflux:start'),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('reflux:stop'),
    getState: (): Promise<RefluxState> => ipcRenderer.invoke('reflux:state'),
    getTsvPath: (): Promise<string> => ipcRenderer.invoke('reflux:tsvPath'),
    // offsets.txt 파싱 — anchor 절대주소 + module-base 기준 상대 offset
    getOffsets: (): Promise<{
      ok: boolean;
      error?: string;
      version?: string;
      entries?: Record<string, string>;
      relative?: Record<string, string>;
      mtime?: number;
    }> => ipcRenderer.invoke('reflux:offsets'),
    onState: (cb: (s: RefluxState) => void): (() => void) => {
      const listener = (_evt: unknown, state: RefluxState): void => cb(state);
      ipcRenderer.on('reflux:state', listener);
      return (): void => {
        ipcRenderer.off('reflux:state', listener);
      };
    },
    onTsvChanged: (cb: (e: TsvChangedEvent) => void): (() => void) => { const l = (_e: unknown, ev: TsvChangedEvent): void => cb(ev); ipcRenderer.on('reflux:tsvChanged', l); return () => ipcRenderer.off('reflux:tsvChanged', l); },
  },
  session: {
    getState: (): Promise<InfinitasSessionState> => ipcRenderer.invoke('session:getState'),
    onState: (cb: (s: InfinitasSessionState) => void): (() => void) => { const l = (_e: unknown, s: InfinitasSessionState): void => cb(s); ipcRenderer.on('session:state', l); return () => ipcRenderer.off('session:state', l); },
  },
  account: {
    list: (): Promise<AccountMeta[]> => ipcRenderer.invoke('account:list'),
    readTsv: (iidxId: string): Promise<TsvReadResult> => ipcRenderer.invoke('account:readTsv', iidxId),
    snapshot: (req: AccountSnapshotRequest): Promise<AccountSnapshotResult> => ipcRenderer.invoke('account:snapshot', req),
    getLastSelected: (): Promise<string | null> => ipcRenderer.invoke('account:lastSelected:get'),
    setLastSelected: (iidxId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('account:lastSelected:set', iidxId),
  },

  // ereter.net 데이터 (perlevel ★ 값) 캐시 + 24h TTL
  ereter: {
    get: (force = false): Promise<EreterGetResult> => ipcRenderer.invoke('ereter:get', force),
    status: (): Promise<EreterCacheStatus> => ipcRenderer.invoke('ereter:status'),
    dataPath: (): Promise<string> => ipcRenderer.invoke('ereter:dataPath'),
  },

  // zasa.sakura.ne.jp 보충 데이터 (DP12 격자 미분류 곡 fallback)
  zasa: {
    get: (force = false): Promise<ZasaGetResult> => ipcRenderer.invoke('zasa:get', force),
    status: (): Promise<ZasaCacheStatus> => ipcRenderer.invoke('zasa:status'),
  },

  // SP ☆12 서열표 (외부 구글 시트 ☆12参考表 하드/노마게 간이표)
  spTier: {
    get: (force = false): Promise<SpTierGetResult> => ipcRenderer.invoke('sptier:get', force),
    status: (): Promise<SpTierCacheStatus> => ipcRenderer.invoke('sptier:status'),
  },

  // 원격 service status (gist 의 service-status.json — uploadEnabled / shelfEnabled toggle).
  // main 에서 Node fetch — renderer 의 Chromium CORS 정책 우회.
  serviceStatus: {
    get: (): Promise<ServiceStatus> => ipcRenderer.invoke('serviceStatus:get'),
  },

  // ohSorryRating (ereter 미등록 lv11/lv12 차트 추정값 — 추천 풀 fallback)
  // 우선순위: ereter > rating. rating 은 ereter 매칭 실패 시에만 사용.
  rating: {
    get: (force = false): Promise<RatingGetResult> => ipcRenderer.invoke('rating:get', force),
    status: (): Promise<RatingCacheStatus> => ipcRenderer.invoke('rating:status'),
  },

  // gist offsets.json 의 프로필 메모리 offset (useProfile 기본값)
  //   문자열 필드(djName/iidxId)와 숫자 필드(radar/dan)가 같은 맵에 섞여 온다 — RemoteProfileMap 참고.
  offsets: {
    getProfile: (): Promise<{
      // 값이 null 인 필드 = 이 빌드에서 주소 미상 → 읽기 건너뜀 (useProfile pickDef 참고)
      profile: RemoteProfileMap | null;
      buildVersion: string | null;
      confidence: 'matched' | 'latest' | 'blind' | 'legacy' | null;
    } | null> => ipcRenderer.invoke('offsets:getProfile'),
  },

  // 포터블 자동 다운로드 + 실행 (v0.0.19+)
  portable: {
    download: (url: string, fileName: string): Promise<string> =>
      ipcRenderer.invoke('portable:download', { url, fileName }),
    run: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('portable:run', filePath),
    onProgress: (cb: (p: { downloaded: number; total: number }) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, p: { downloaded: number; total: number }) => cb(p);
      ipcRenderer.on('portable:progress', listener);
      return () => ipcRenderer.removeListener('portable:progress', listener);
    },
  },

  // GitHub 최신 릴리즈 체크 — 알림 전용 (자동 다운로드 X)
  update: {
    check: (): Promise<UpdateInfo> => ipcRenderer.invoke('update:check'),
  },

  // 캡처 이미지 자동 저장 (사진 폴더 / INFOhSorry / *.png)
  saveImage: (
    data: ArrayBuffer | string,
    defaultName?: string,
  ): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('image:save', data, defaultName),

  // 진단용 (현재 미사용, 나중에 INFINITAS 실행 감지에 활용)
  probe: (exeName: string): Promise<ProbeResult> => ipcRenderer.invoke('memory:probe', exeName),

  // 메모리 스캐너 (DJ NAME / IIDX ID offset 찾기 + 저장된 offset 으로 읽기)
  memory: {
    scan: (
      exeName: string,
      text: string,
    ): Promise<{
      ok: boolean;
      error?: string;
      modBase?: string;
      modSize?: number;
      results?: { encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis'; absolute: string; relative: string; relativeRaw: string }[];
    }> => ipcRenderer.invoke('memory:scan', exeName, text),
    // refine scan — 이전 매치 목록의 각 주소에서 새 값과 일치하는 것만 keep (Cheat Engine 의 next scan)
    refineScan: (
      exeName: string,
      text: string,
      prev: { encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis'; absolute: string }[],
    ): Promise<{
      ok: boolean;
      error?: string;
      modBase?: string;
      modSize?: number;
      results?: { encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis'; absolute: string; relative: string; relativeRaw: string }[];
    }> => ipcRenderer.invoke('memory:refine-scan', exeName, text, prev),
    readString: (
      exeName: string,
      relativeOffset: string,
      encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis',
      maxBytes?: number,
    ): Promise<{ ok: boolean; text?: string; error?: string; processMissing?: boolean }> =>
      ipcRenderer.invoke('memory:read-string', exeName, relativeOffset, encoding, maxBytes),
    // int32 배열 읽기 (노트레이더 / 단위) — count 는 main 에서 1~64 로 clamp.
    readInts: (
      exeName: string,
      relativeOffset: string,
      count: number,
    ): Promise<{ ok: boolean; values?: number[]; error?: string; processMissing?: boolean }> =>
      ipcRenderer.invoke('memory:read-ints', exeName, relativeOffset, count),
    findAnchor: (
      exeName: string,
      heapAddr: string,
    ): Promise<{
      ok: boolean;
      error?: string;
      modBase?: string;
      candidates?: {
        pointerAbs: string;
        pointerRel: string;
        anchorName: string | null;
        anchorDelta: string | null;
        valueOffset: string;
      }[];
      refluxVersion?: string | null;
      directHits?: number;
    }> => ipcRenderer.invoke('memory:find-anchor', exeName, heapAddr),
    readViaAnchor: (
      exeName: string,
      anchorName: string,
      delta: string,
      encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis',
      maxBytes?: number,
      valueOffset?: string,
    ): Promise<{ ok: boolean; text?: string; error?: string; processMissing?: boolean }> =>
      ipcRenderer.invoke(
        'memory:read-via-anchor',
        exeName,
        anchorName,
        delta,
        encoding,
        maxBytes,
        valueOffset,
      ),
  },

  // 셸 액션
  shell: {
    showInFolder: (path: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('shell:showInFolder', path),
  },

  // 창 컨트롤 (frameless 모드)
  window: {
    minimize: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: (): Promise<{ ok: boolean; maximized?: boolean }> =>
      ipcRenderer.invoke('window:maximize-toggle'),
    close: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_evt: unknown, m: boolean): void => cb(m);
      ipcRenderer.on('window:maximized', listener);
      return (): void => {
        ipcRenderer.off('window:maximized', listener);
      };
    },
  },

  // 원격모드(LAN 로컬보드) — renderer 가 계산한 오소리웹 user 객체(별값 + charts_json)를 main 에 push.
  //   http-server /api/me 가 이 값을 노출 → 폰 등 원격 클라이언트가 본인 카드를 실시간으로 받음.
  remote: {
    setUser: (user: unknown): Promise<{ ok: boolean }> => ipcRenderer.invoke('remote:setUser', user),
  },

  // 추천 브릿지 — main(http-server /api/recommend, OpenWebUI 챗봇용)이 추천 요청을 보내면
  //   renderer 가 recCtx(코어 recommend.js)로 계산해 응답한다. upload 채널과 같은 패턴.
  recommend: {
    onRequest: (cb: (req: { reqId: string; kind: string; params?: Record<string, unknown> }) => void): (() => void) => {
      const listener = (_evt: unknown, req: { reqId: string; kind: string; params?: Record<string, unknown> }): void => cb(req);
      ipcRenderer.on('recommend:request', listener);
      return (): void => {
        ipcRenderer.off('recommend:request', listener);
      };
    },
    respond: (payload: { reqId: string; ok: boolean; result?: unknown; error?: string }): void =>
      ipcRenderer.send('recommend:response', payload),
  },

  // 업로드 — main(앱 종료/INFINITAS 종료 감지)이 "마지막 업로드" 를 요청하면 renderer 가 받아 1회 업로드 후 done 신호.
  upload: {
    onFinalRequest: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('upload:final-request', listener);
      return (): void => {
        ipcRenderer.off('upload:final-request', listener);
      };
    },
    finalDone: (outcome: import('../shared/uploadSnapshot').UploadOutcome): void => ipcRenderer.send('upload:final-done', outcome),
    savePending: (snapshot: import('../shared/uploadSnapshot').UploadSnapshot) => ipcRenderer.invoke('upload:savePending', snapshot),
    loadPending: () => ipcRenderer.invoke('upload:loadPending'),
    clearPending: (iidxId: string) => ipcRenderer.invoke('upload:clearPending', iidxId),
  },

  // 진단 로그 — addDiagLine 이 파일에도 append 하도록 IPC 로 전달(fire-and-forget). PC2 에선 no-op(src/renderer/src/api.ts 참고).
  diag: {
    append: (line: string): void => ipcRenderer.send('diag:append', line),
    logPath: (): Promise<string> => ipcRenderer.invoke('diag:logPath'),
  },

  // LAN 접속정보 — 폰 QR/주소 표시용. http-server 미시작(dev)이면 null.
  server: {
    info: (): Promise<unknown> => ipcRenderer.invoke('server:info'),
  },
};

contextBridge.exposeInMainWorld('infohsorry', api);
