// 렌더러에서 window.infohsorry 의 타입 인식하도록 ambient declaration
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
import type { RemoteProfileMap } from '../shared/profileOffsets';
import type { InfinitasSessionState } from '../shared/session';
import type { AccountMeta, TsvChangedEvent, AccountSnapshotRequest, AccountSnapshotResult } from '../shared/account';

declare global {
  interface Window {
    infohsorry: {
      readTsv: (path: string) => Promise<TsvReadResult>;
      clearTsv: (path: string) => Promise<{ ok: boolean; cleared?: boolean; error?: string }>;
      reflux: {
        start: () => Promise<RefluxStartResult>;
        stop: () => Promise<{ ok: boolean }>;
        restart: () => Promise<{ ok: boolean; error?: string }>;
        getState: () => Promise<RefluxState>;
        getTsvPath: () => Promise<string>;
        getOffsets: () => Promise<{
          ok: boolean;
          error?: string;
          version?: string;
          entries?: Record<string, string>;
          relative?: Record<string, string>;
          mtime?: number;
        }>;
        onState: (cb: (s: RefluxState) => void) => () => void;
        onTsvChanged: (cb: (e: TsvChangedEvent) => void) => () => void;
      };
      session: { getState: () => Promise<InfinitasSessionState>; onState: (cb: (s: InfinitasSessionState) => void) => () => void };
      account: {
        list: () => Promise<AccountMeta[]>;
        readTsv: (iidxId: string) => Promise<TsvReadResult>;
        snapshot: (req: AccountSnapshotRequest) => Promise<AccountSnapshotResult>;
        getLastSelected: () => Promise<string | null>;
        setLastSelected: (iidxId: string) => Promise<{ ok: boolean }>;
      };
      ereter: {
        get: (force?: boolean) => Promise<EreterGetResult>;
        status: () => Promise<EreterCacheStatus>;
        dataPath: () => Promise<string>;
      };
      zasa: {
        get: (force?: boolean) => Promise<ZasaGetResult>;
        status: () => Promise<ZasaCacheStatus>;
      };
      spTier: {
        get: (force?: boolean) => Promise<SpTierGetResult>;
        status: () => Promise<SpTierCacheStatus>;
      };
      serviceStatus: {
        get: () => Promise<ServiceStatus>;
      };
      rating: {
        get: (force?: boolean) => Promise<RatingGetResult>;
        status: () => Promise<RatingCacheStatus>;
      };
      offsets: {
        // 게임 datecode 로 고른 build 의 profile offset. 값이 null 인 필드 = 이 빌드에서 주소 미상.
        //   문자열 필드({offset,encoding,maxBytes}) 와 숫자 필드({offset,count,scale}) 가 섞인 맵.
        getProfile: () => Promise<{
          profile: RemoteProfileMap | null;
          buildVersion: string | null;
          confidence: 'matched' | 'latest' | 'blind' | 'legacy' | null;
        } | null>;
      };
      portable: {
        download: (url: string, fileName: string) => Promise<string>;
        run: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
        onProgress: (cb: (p: { downloaded: number; total: number }) => void) => () => void;
      };
      update: {
        check: () => Promise<UpdateInfo>;
      };
      saveImage: (
        data: ArrayBuffer | string,
        defaultName?: string,
      ) => Promise<{ ok: boolean; path?: string; error?: string }>;
      probe: (exeName: string) => Promise<ProbeResult>;
      memory: {
        scan: (
          exeName: string,
          text: string,
        ) => Promise<{
          ok: boolean;
          error?: string;
          modBase?: string;
          modSize?: number;
          results?: {
            encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis';
            absolute: string;
            relative: string;
            relativeRaw: string;
          }[];
        }>;
        refineScan: (
          exeName: string,
          text: string,
          prev: { encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis'; absolute: string }[],
        ) => Promise<{
          ok: boolean;
          error?: string;
          modBase?: string;
          modSize?: number;
          results?: {
            encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis';
            absolute: string;
            relative: string;
            relativeRaw: string;
          }[];
        }>;
        readString: (
          exeName: string,
          relativeOffset: string,
          encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis',
          maxBytes?: number,
        ) => Promise<{ ok: boolean; text?: string; error?: string; processMissing?: boolean }>;
        readInts: (
          exeName: string,
          relativeOffset: string,
          count: number,
        ) => Promise<{ ok: boolean; values?: number[]; error?: string; processMissing?: boolean }>;
        findAnchor: (
          exeName: string,
          heapAddr: string,
        ) => Promise<{
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
        }>;
        readViaAnchor: (
          exeName: string,
          anchorName: string,
          delta: string,
          encoding: 'utf16le' | 'utf8' | 'ascii' | 'shiftjis',
          maxBytes?: number,
          valueOffset?: string,
        ) => Promise<{ ok: boolean; text?: string; error?: string; processMissing?: boolean }>;
      };
      shell: {
        showInFolder: (path: string) => Promise<{ ok: boolean }>;
      };
      window: {
        minimize: () => Promise<{ ok: boolean }>;
        maximizeToggle: () => Promise<{ ok: boolean; maximized?: boolean }>;
        close: () => Promise<{ ok: boolean }>;
        isMaximized: () => Promise<boolean>;
        onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
      };
      remote: {
        setUser: (user: unknown) => Promise<{ ok: boolean }>;
      };
      recommend: {
        onRequest: (
          cb: (req: { reqId: string; kind: string; params?: Record<string, unknown> }) => void,
        ) => () => void;
        respond: (payload: { reqId: string; ok: boolean; result?: unknown; error?: string }) => void;
      };
      upload: {
        onFinalRequest: (cb: () => void) => () => void;
        finalDone: (outcome: import('../shared/uploadSnapshot').UploadOutcome) => void;
        savePending?: (snapshot: import('../shared/uploadSnapshot').UploadSnapshot) => Promise<{ ok: boolean; error?: string; path?: string; bytes?: number }>;
        loadPending?: () => Promise<import('../shared/uploadSnapshot').UploadSnapshot[]>;
        clearPending?: (iidxId: string) => Promise<{ ok: boolean; error?: string; path?: string }>;
      };
      diag: {
        append: (line: string) => void;
        logPath: () => Promise<string>;
      };
      server: {
        info: () => Promise<{
          ip: string | null;
          port: number;
          port80: boolean;
          localName: string;
          url: string | null;
          nameUrl: string;
          qr: string | null;
        } | null>;
      };
    };
  }
}

export {};
