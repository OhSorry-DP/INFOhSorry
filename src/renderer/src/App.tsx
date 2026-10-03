import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChartSlot, EreterCacheStatus, EreterData, NotInInfChart, RatingData, RefluxState, SongRow, SpTierData, StarResult, UpdateInfo, ZasaData } from '../../shared/types';
import './api';
import { DP_SLOTS, SP_SLOTS, extractCharts } from '../../shared/types';
import { buildEreterIndex, lampNum, norm, slotToDiff } from '../../shared/match';
import { isVariantTitle } from '../../shared/variants';
import {
  type RecCandidate,
  type RecDjMode,
  type RecInputChart,
  type RecLevelMode,
  type RecStage,
} from '../../shared/recommend';

// RecCard 의 stage union — shared 의 RecStage (ec/hc/exh, buildRecs 인자) + 연습곡 'weakness'.
type CardStage = RecStage | 'weakness';
import { lampStyle, letterColor } from './lampStyle';
import ChartTable from './ChartTable';
import DpTable from './DpTable';
import Analysis from './Analysis';
import Recent from './Recent';
import PlayData from './PlayData';
import { computeClient, rendererInput } from './compute/rendererService';
import { analysisUploadLedger } from './compute/analysisUploadGate';
import { useComputeTask, useSnapshotResources } from './compute/useComputeTask';
import { starBundle } from './compute/rendererState';
import { isUploadReady } from './compute/acceptedBundle';
import { waitForBundle } from './compute/waitForBundle';
import { useRecommendService } from './compute/useRecommendService';
import { useRecommendBridge } from './useRecommendBridge';
import { DATA_BASE } from '../../shared/dataSource';

// SP 대표 실력값(発狂★相当) — ohSorryRating spSkillCpi 커널(gist) 입출력 타입.
interface SpSkillResult { cpi: number | null; cpiInt: number | null; star: number | null; starRounded: number | null; sl: number | null; st: number | null; nPairs: number;
  // computeSpStarGuarded 추가 필드 — sp_star = max(unified85★, guardedGaugeAvg50). cpi/cpiInt 는 unified 원좌표.
  uniStar?: number | null; uniStarRounded?: number | null; gaugeAvg?: number | null; applied?: boolean }
import { ThemeToggle, WindowControls } from './theme';
import { MemoryScanner } from './MemoryScanner';
import { QrConnect } from './QrConnect';
import { ProfileCard } from './ProfileCard';
import AccountSelector from './AccountSelector';
import { readIidxIdFresh, useProfile, type ProfileInfo } from './useProfile';
import type { RadarValues } from './NotesRadar';
import { uploadProfile, fetchUserPublic, getSongsCache, getTextageByTitle, type UserPublicInfo } from './supabaseSync';
import { planScoreSync } from './scoreSync';
import { buildRemoteUser } from './remoteUser';
import { IS_BROWSER_REMOTE } from './api';
import { SNAPSHOT_VERSION, type SnapshotReason, type UploadOutcome, type UploadSnapshot } from '../../shared/uploadSnapshot';
import { isFloorSeedCurrent, resolveAccountSnapshotProfile, type AccountScope, type AccountMeta, type TsvChangedEvent } from '../../shared/account';
import type { InfinitasSessionState } from '../../shared/session';
import { addDiagLine, getDiagLines, subscribeDiagLog } from './diagLog';
import { isUploadDue } from './uploadDue';
import { INITIAL_AUTO_UPLOAD_STABLE_MS } from './initialAutoUpload';
import { transferFloor, reuseOsrInput } from './scopedCalculation';
import { perfEvent, perfScopeId } from './perfDiag';

// 원격 프로필 push 변경 감지에 사용하는 레이더 문자열.
function radarSig(r: RadarValues | null | undefined): string {
  if (!r) return 'x';
  return [r.notes, r.peak, r.charge, r.chord, r.scratch, r.soft]
    .map((v) => Math.round((typeof v === 'number' ? v : 0) * 100))
    .join(',');
}


declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;
// 실력값 추정 + Supabase 업로드 주기 — 타이머를 쓰지 않는다.
//   계정별 마지막 업로드 성공 시각(시스템 시간)을 localStorage 에 찍어 두고, TSV 스냅샷을 얻을 때마다
//   「지금 − 마지막 업로드 ≥ AUTO_UPLOAD_MIN_GAP_MS(3분)」면 올린다(isUploadDue). 기록이 없으면 바로 올린다.
//   기록이 바뀔 때마다 판정하므로 10분 주기를 기다리지 않는다(v0.0.125 변경 업로드와 같은 3분 간격).
//   종래 「3분 뒤 첫 업로드 + 10분 setInterval」은 스냅샷이 ref 로만 들어와 무장 effect 가 다시 안 돌면
//   타이머가 영영 안 걸려 자동 업로드가 통째로 멈췄다.
//   추가로 앱 종료 / INFINITAS 종료 감지 시 main 이 마지막 업로드를 1회 요청(upload.onFinalRequest).
//   ※ 리모트 실시간 푸시(me:update SSE) / TSV reload 는 이 주기와 무관(별도 effect).
// 즉시 올리고 싶으면 콘솔에서 window.updateSupabase() 수동 호출.
const AUTO_UPLOAD_MIN_GAP_MS = 3 * 60 * 1000; // 기록 변경 업로드 최소 간격 — 3분(dump-user 20~26초라 겹치지 않는다)
const INITIAL_AUTO_UPLOAD_DELAY_MS = INITIAL_AUTO_UPLOAD_STABLE_MS;
const MANUAL_UPLOAD_COOLDOWN_MS = 5 * 60 * 1000;
const LAST_UPLOAD_KEY_PREFIX = 'infohsorry.lastUploadAt.';
// 계정별 마지막 업로드 성공 시각. 읽기 실패·손상은 0(기록 없음 → 바로 업로드)으로 본다.
function readLastUploadAt(iidxId: string): number {
  try {
    const value = Number(localStorage.getItem(LAST_UPLOAD_KEY_PREFIX + iidxId));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch { return 0; }
}
function writeLastUploadAt(iidxId: string, at: number): void {
  try { localStorage.setItem(LAST_UPLOAD_KEY_PREFIX + iidxId, String(at)); } catch { /* 저장 실패 시 다음 스냅샷에서 다시 올린다 */ }
}
const SNAPSHOT_RETRY_INTERVAL_MS = 15 * 1000;
const SNAPSHOT_RETRY_REPORT_AFTER = 4;
const ID_SWITCH_SNAPSHOT_BLOCK_MS = 20 * 1000; // Reflux 재기동 직후 부분 tracker.tsv 스냅샷 방지

type Tab = 'sp' | 'dp' | 'dp12' | 'analysis' | 'recent' | 'playdata' | 'grid';
const VALID_IIDX_ID = /^[A-Z]\d{12}$/;
type SnapshotCaptureResult =
  | { ok: true; iidxId: string; generation: number; tsvMtime: number }
  | { ok: false; reason: 'fresh-id-unavailable'; fresh: { processMissing: boolean; error: string | null; iidxId: string | null } }
  | { ok: false; reason: 'id-switch-cooldown' }
  | { ok: false; reason: 'snapshot-rejected'; snapshotReason: SnapshotReason | string | undefined }
  | { ok: false; reason: 'exception'; error: string };

function freshIdFailureDetail(fresh: { processMissing: boolean; error?: string | null; iidxId: string | null }): string {
  const parts = [
    fresh.processMissing ? '게임 프로세스 미검출' : '',
    fresh.error ? `error=${fresh.error}` : '',
    !fresh.iidxId ? 'IIDX ID 없음' : !VALID_IIDX_ID.test(fresh.iidxId) ? `IIDX ID 형식 오류(${fresh.iidxId})` : '',
  ].filter(Boolean);
  return parts.join(' / ') || 'IIDX ID 를 메모리에서 다시 확인하지 못함';
}
function snapshotReasonLabel(reason: SnapshotReason | string | undefined): string {
  switch (reason) {
    case 'source-empty': return 'Reflux tracker.tsv 가 비어있음';
    case 'generation-changed':
    case 'pid-mismatch': return '게임 세션이 바뀌는 중이라 건너뜀';
    case 'source-changed': return 'tracker.tsv 가 쓰는 도중이라 건너뜀(다음 시도에서 재시도됨)';
    case 'write-failed': return '파일 쓰기 실패';
    case 'id-format': return 'IIDX ID 형식이 이상함';
    case 'no-live-session': return '게임이 꺼진 상태';
    default: return `알 수 없는 스냅샷 사유(${reason ?? '없음'})`;
  }
}
// 업로드 skip/실패 사유 — Reflux 로그 패널 표시용
function uploadReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case 'game-on': return '게임이 켜진 상태';
    case 'no-selected-account': return '선택한 계정 없음';
    case 'no-account-meta': return '선택한 계정 정보 없음';
    case 'snapshot-empty': return '선택한 계정에 기록 없음';
    case 'rows-owner-mismatch': return '표시 중인 기록이 선택한 계정 것이 아님(로딩 중)';
    case 'no-snapshot-provenance': return '계정 스냅샷이 아직 없음(기록 인식 대기 중)';
    case 'bad-provenance-id': return '스냅샷 ID 형식 이상';
    case 'generation-advanced': return '게임 세션이 바뀜(재시작 감지)';
    case 'game-off': return '게임이 꺼진 상태';
    case 'live-id-mismatch': return '현재 로그인 계정 정보 불일치';
    case 'final-id-mismatch': return '종료 시점 계정 정보 불일치';
    case 'fresh-id-mismatch': return '메모리 재확인 ID 불일치';
    case 'snapshot-guard': return '프로필 정보 부족(닉네임/ID 미확인)';
    case 'browser-remote': return '원격 뷰어라 업로드 대상 아님';
    default: return `알 수 없는 업로드 skip 사유(${reason ?? '없음'})`;
  }
}
// "방금 전" / "5분 전" / "1시간 전" / "어제 14:32" / "2026-05-08 14:32" 같은 상대 시간
function formatRelativeTime(epochMs: number): string {
  const diffSec = Math.max(0, (Date.now() - epochMs) / 1000);
  if (diffSec < 60) return '방금 전';
  if (diffSec < 60 * 60) return `${Math.floor(diffSec / 60)}분 전`;
  if (diffSec < 60 * 60 * 24) return `${Math.floor(diffSec / 3600)}시간 전`;
  const d = new Date(epochMs);
  const now = new Date();
  const yMd = (x: Date): string =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // 어제면 "어제 HH:MM", 그 외 "YYYY-MM-DD HH:MM"
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (yMd(d) === yMd(yesterday)) return `어제 ${hm}`;
  return `${yMd(d)} ${hm}`;
}

export default function App() {
  const [refluxState, setRefluxState] = useState<RefluxState>({
    stage: 'idle',
    installed: false,
    spawned: false,
  });
  const [diagLines, setDiagLines] = useState<string[]>(() => getDiagLines());
  useEffect(() => subscribeDiagLog(() => setDiagLines(getDiagLines())), []);
  const [diagLogPath, setDiagLogPath] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    window.infohsorry?.diag?.logPath().then((p) => { if (alive) setDiagLogPath(p); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const [rowsState, setRowsState] = useState<{ rows: SongRow[]; scope: AccountScope }>({ rows: [], scope: { iidxId: null, epoch: 0 } });
  const rows = rowsState.rows;
  const rowsOwnerId = rowsState.scope.iidxId;
  const rowsRef = useRef<SongRow[]>([]);
  const rowsRevisionRef = useRef(0);
  const rowsScopeRef = useRef<AccountScope>(rowsState.scope);
  const accountScopeRef = useRef<AccountScope>({ iidxId: null, epoch: 0 });
  const viewerReadSeqRef = useRef(0);
  const [tsvMtime, setTsvMtime] = useState<number>(0);
  const tsvMtimeRef = useRef<number>(0);
  const [floorState, setFloorState] = useState<{ scope: AccountScope; starFloor: number | null; rStarFloor: number | null }>({ scope: { iidxId: null, epoch: 0 }, starFloor: null, rStarFloor: null });
  const floorLogRef = useRef(floorState);
  useEffect(() => {
    const old = floorLogRef.current;
    if (old.starFloor !== floorState.starFloor) perfEvent('floor-update', { origin: 'effect', calc: 'dp', old: old.starFloor, new: floorState.starFloor, changed: true, epoch: floorState.scope.epoch });
    if (old.rStarFloor !== floorState.rStarFloor) perfEvent('floor-update', { origin: 'effect', calc: 'r', old: old.rStarFloor, new: floorState.rStarFloor, changed: true, epoch: floorState.scope.epoch });
    floorLogRef.current = floorState;
  }, [floorState]);
  const floorCurrent = isFloorSeedCurrent(floorState.scope, rowsState.scope);
  const starFloor = floorCurrent ? floorState.starFloor : null;
  const rStarFloor = floorCurrent ? floorState.rStarFloor : null;
  const [userPublic, setUserPublic] = useState<UserPublicInfo>({ dpRadar: null, star: null, rStar: null, spRank: null, dpRank: null });
  const [userPublicScope, setUserPublicScope] = useState<AccountScope | null>(null);
  const osrAccumRef = useRef<Map<string, { title: string; diff: string; lampNum: number }>>(new Map());
  const osrAccumScopeRef = useRef<AccountScope>({ iidxId: null, epoch: 0 });
  const [session, setSession] = useState<InfinitasSessionState>({ pid: null, generation: 0, startedAt: null });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [selectedViewerId, setSelectedViewerId] = useState<string | null>(null);
  const selectedViewerIdRef = useRef<string | null>(null);
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const accountsRef = useRef<AccountMeta[]>([]);
  const accountsListSeqRef = useRef(0);
  const refreshAccounts = useCallback(async (expectedScope?: AccountScope): Promise<boolean> => {
    const seq = ++accountsListSeqRef.current;
    const list = await window.infohsorry.account.list();
    if (seq !== accountsListSeqRef.current) return false;
    if (expectedScope && !isFloorSeedCurrent(expectedScope, accountScopeRef.current)) return false;
    accountsRef.current = list;
    setAccounts(list);
    return true;
  }, []);
  useEffect(() => { accountsRef.current = accounts; }, [accounts]);
  const invalidateAccountScope = useCallback((nextId: string | null, clearRows: boolean): void => {
    const previous = accountScopeRef.current;
    const scope = { iidxId: nextId, epoch: previous.epoch + 1 };
    accountScopeRef.current = scope;
    uploadStateRef.current.bundleReady = false;
    computeClient.invalidateScope();
    analysisUploadLedger.clear();
    viewerReadSeqRef.current += 1;
    const previousRowsOwner = rowsScopeRef.current;
    setFloorState((floor) => transferFloor(floor, previous, previousRowsOwner, scope, clearRows));
    setUserPublic({ dpRadar: null, star: null, rStar: null, spRank: null, dpRank: null });
    setUserPublicScope(null);
    osrAccumRef.current.clear();
    osrAccumScopeRef.current = scope;
    const nextRows = clearRows || previous.iidxId !== nextId ? [] : rowsRef.current;
    rowsRef.current = nextRows;
    rowsScopeRef.current = scope;
    perfEvent('scope-invalidate', { reason: 'account', previousEpoch: previous.epoch, epoch: scope.epoch, clearRows });
    setRowsState({ rows: nextRows, scope });
    if (clearRows) {
      tsvMtimeRef.current = 0;
      setTsvMtime(0);
    }
  }, []);
  const commitAccountRows = useCallback((expectedScope: AccountScope, readSeq: number, expectedSession: { pid: number | null; generation: number }, nextRows: SongRow[], mtime: number): boolean => {
    if (!isFloorSeedCurrent(expectedScope, accountScopeRef.current)
      || viewerReadSeqRef.current !== readSeq
      || selectedViewerIdRef.current !== expectedScope.iidxId
      || sessionRef.current.pid !== expectedSession.pid
      || sessionRef.current.generation !== expectedSession.generation) return false;
    rowsRef.current = nextRows;
    rowsRevisionRef.current += 1;
    uploadStateRef.current.bundleReady = false;
    rowsScopeRef.current = expectedScope;
    setRowsState({ rows: nextRows, scope: expectedScope });
    tsvMtimeRef.current = mtime;
    perfEvent('rows-commit', { source: 'account-read', rowsRev: rowsRevisionRef.current, rowsCount: nextRows.length, epoch: expectedScope.epoch,
      scopeId: perfScopeId(expectedScope.iidxId) });
    setTsvMtime(mtime);
    return true;
  }, []);
  const loadViewerAccount = useCallback(async (id: string): Promise<void> => {
    if (!id || !VALID_IIDX_ID.test(id)) return;
    if (selectedViewerIdRef.current !== id) invalidateAccountScope(id, true);
    selectedViewerIdRef.current = id;
    setSelectedViewerId(id);
    const viewer = window.infohsorry;
    void viewer.account.setLastSelected(id);
    const scope = { ...accountScopeRef.current };
    const readSeq = ++viewerReadSeqRef.current;
    const expectedSession = { pid: sessionRef.current.pid, generation: sessionRef.current.generation };
    let t;
    try {
      t = await viewer.account.readTsv(id);
    } catch (err) {
      if (commitAccountRows(scope, readSeq, expectedSession, [], 0)) console.warn('[viewer] account.readTsv rejected:', err);
      return;
    }
    if (t.ok) {
      commitAccountRows(scope, readSeq, expectedSession, t.rows ?? [], t.mtime ?? 0);
    } else {
      if (!commitAccountRows(scope, readSeq, expectedSession, [], 0)) return;
      console.warn('[viewer] account.readTsv failed:', t.error);
      addDiagLine(`저장된 기록(${id}) 읽기 실패: ${t.error ?? '알 수 없는 오류'}`);
    }
  }, [commitAccountRows, invalidateAccountScope]);
  const [tab, setTab] = useState<Tab>('playdata');
  // 추천곡 클릭 → DP 탭 + 해당 row 로 스크롤 타깃
  const [scrollTarget, setScrollTarget] = useState<{ title: string; slot: string; gameLevel?: number | null } | null>(null);
  // SP 서열표 곡 클릭 → PLAYDATA 탭 + 토글/diff 맞추고 검색창에 곡명 입력
  const [playDataTarget, setPlayDataTarget] = useState<{ title: string; slot: string } | null>(null);
  // 옛 ID 의 tsv 가 메모리에 남아 새 ID 로 잘못 업로드되는 사고 방지용 — 옛 IIDX ID 추적.
  // truthy → null transition (= 게임 종료 / 다른 ID 로 로그인 전 단계) 감지 시 tsv 비우기 + 로딩 데이터 reset.
  // "세션 중 한 번이라도 유효한 IIDX ID 가 잡힌 적 있는지" 추적 — false-positive 방어.
  //   INFINITAS 미실행 / 메모리 잡음으로 잠깐 truthy 가 잡혔다 사라지는 케이스에선 transit 인식 X.
  //   유효 조건: Reflux 가 hooked/ready 상태 + iidx_id 형식 매칭 (^[A-Z]\d{12}$).
  // null 상태 debounce timer — null 이 5초 이상 *지속* 되어야 진짜 transit 으로 판정.
  //   "데이터 불러오기" 클릭 / health-check 자동 재시작 시 stage='starting' / 'hooking' 거치는 동안
  //   useProfile 이 iidxId 를 null 로 잠깐 reset 함 → 5초 안에 ready 가 되어 다시 잡히면 cancel.
  //   INFINITAS 진짜 종료 시는 null 이 계속 유지되어 5초 후 cleanup 발동.
  // 마지막으로 잡힌 "유효" IIDX ID — 계정 전환을 직전 tick(prev)이 아니라 이 값 대비로 감지.
  //   게임 재시작 시 useProfile 이 iidxId 를 잠깐 null 로 리셋 → 시퀀스가 A→null→B 가 되는데,
  //   prev(직전 tick)만 보면 B 도착 시 prev=null 이라 A→B 전환을 놓침(옛 계정 rows·별값 잔존).
  //   null 공백을 건너뛰고 "직전 유효 ID ≠ 새 유효 ID" 로 판정하기 위한 앵커.
  // useProfile가 게임 종료 뒤 null을 발행해도, doReset 직전의 identity/profile payload를 보존한다.
  const snapshotRetryTimerRef = useRef<number | null>(null);
  const snapshotRetryFailuresRef = useRef(0);
  const lastSnapshotRetryReportRef = useRef<string | null>(null);
  const snapshotRetrySessionRef = useRef<{ pid: number | null; generation: number } | null>(null);
  const lastSnapshotFreshFailureRef = useRef<string | null>(null);
  const snapshotBlockUntilRef = useRef(0);
  const lastValidIidxIdRef = useRef<string | null>(null);
  const lastValidProfileRef = useRef<ProfileInfo | null>(null);
  // 현재 rows(TSV 점수) 가 어느 IIDX ID 의 덤프에서 온 것인지 — TSV read 성공 시 그 시점 live ID 로 태깅.
  //   업로드 직전 현재 ID 와 비교해, ID 가 바뀐 뒤 옛 rows 가 새 ID 로 잘못 올라가는 것을 차단(이중 안전장치).
  // spawn 직후 최초 read 한 디스크 tracker.tsv 의 mtime("세션 baseline"). 이 값 이하의 read = 디스크 잔존
  //   옛 유저 TSV(cross-restart stale)일 수 있어 표시 전용. 이 값을 "초과"하는 read 만 = 이번 세션 새 덤프 →
  //   업로드 출처로 승격(HOLE 2 차단). null = baseline 미설정(빈 파일로 시작 등) → 첫 실데이터를 fresh 로 인정.
  const lastSnapshotRef = useRef<{ iidxId: string; generation: number; tsvMtime: number } | null>(null);
  const [memoryScannerOpen, setMemoryScannerOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);   // 폰 연결 QR 모달
  // 개발 모드 — 호스트 (Electron) 에서만 콘솔에 startdev() 노출. PC2 (브라우저 원격) 에선 비활성.
  // 활성 시 Reflux 토글 / 프로필 스캐너 / StarPanel 등 디버그 요소 표시.
  const [devMode, setDevMode] = useState(false);
  useEffect(() => {
    if (IS_BROWSER_REMOTE) return;
    (window as unknown as { startdev?: () => void }).startdev = () => {
      setDevMode(true);
      console.log('[dev] startdev() — Reflux 토글 / 프로필 스캐너 / StarPanel 활성');
    };
    return () => {
      delete (window as unknown as { startdev?: () => void }).startdev;
    };
  }, []);
  useEffect(() => {
    if (IS_BROWSER_REMOTE) return;
    const win = window as unknown as {
      syncScores?: (iidxId?: string, opts?: { force?: boolean }) => Promise<unknown>;
    };
    win.syncScores = async (iidxId?: string, opts?: { force?: boolean }) => {
      try {
        const id = iidxId || selectedViewerIdRef.current;
        if (!id) throw new Error('선택된 IIDX ID가 없습니다.');
        const tsv = await window.infohsorry.account.readTsv(id);
        if (!tsv.ok || !tsv.rows) throw new Error(tsv.error || 'tracker.tsv 읽기 실패');
        const plan = await planScoreSync(id, tsv.rows, opts);
        console.table(plan.counts);
        console.table(plan.deletions.map((d) => ({
          scoreId: d.scoreId,
          title: d.title,
          slot: d.slot,
          dateKst: d.dateKst,
          dbExScore: d.db.exScore,
          dbLamp: d.db.lamp,
          tsvExScore: d.tsv?.exScore ?? null,
          tsvLamp: d.tsv?.lamp ?? null,
          category: d.category,
        })));
        if (plan.ambiguousSamples.length > 0) console.table(plan.ambiguousSamples);
        console.log(`tsv: 차트 ${plan.tsvStats.charts} / 플레이 ${plan.tsvStats.played} / 곡 매칭 실패 ${plan.tsvStats.unmatched}`);
        if (plan.blockedByRatio) {
          console.warn('[syncScores] 삭제 대상이 INF 기록의 30% 를 넘어 SQL 을 만들지 않았다 — tsv 가 오염됐거나 부분 파일일 수 있다. 확인 후에도 진행하려면 syncScores(id, { force: true })');
          return plan;
        }
        if (!plan.sql) {
          console.log('[syncScores] 삭제할 행이 없다.');
          return plan;
        }
        console.log(plan.sql);
        if (plan.sql) {
          try {
            await navigator.clipboard.writeText(plan.sql);
            console.log('생성된 SQL을 클립보드에 복사했습니다.');
          } catch (e) {
            console.log('SQL 클립보드 복사 실패:', e);
          }
        }
        console.log('Supabase SQL Editor에 붙여넣어 실행한 뒤, 게임을 끈 상태에서 수동 업로드로 정상 기록을 다시 올려라.');
        return plan;
      } catch (e) {
        console.error('[syncScores] 실패:', e);
        return null;
      }
    };
    return () => {
      delete win.syncScores;
    };
  }, []);
  const [tsvPath, setTsvPath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 디스크에서 마지막으로 읽은 tracker.tsv 의 mtime — 같은 mtime 으로 중복 reload 방지
  const lastLoadedMtime = useRef<number>(0);
  const [lastUploadAt, setLastUploadAt] = useState(0);
  const lastUploadAtRef = useRef(0);
  const [manualUploadBusy, setManualUploadBusy] = useState(false);
  const manualUploadBusyRef = useRef(false);
  const autoUploadBusyRef = useRef(false);
  const initialAutoUploadSucceededRef = useRef(false);
  const [manualUploadNow, setManualUploadNow] = useState(() => Date.now());

  useEffect(() => {
    if (IS_BROWSER_REMOTE) return;
    const tick = window.setInterval(() => setManualUploadNow(Date.now()), 10_000);
    return () => window.clearInterval(tick);
  }, []);

  // ereter ★ 데이터 캐시 상태 + 갱신 진행 표시 + 실제 데이터
  const [ereterStatus, setEreterStatus] = useState<EreterCacheStatus | null>(null);
  const [ereterBusy, setEreterBusy] = useState(false);
  const [ereterData, setEreterData] = useState<EreterData | null>(null);

  // zasa 보충 데이터 (DP12 격자 미분류 fallback)
  const [zasaData, setZasaData] = useState<ZasaData | null>(null);

  // SP ☆12 서열표 (외부 구글 시트 ☆12参考表 하드/노마게 간이표)
  const [spTierData, setSpTierData] = useState<SpTierData | null>(null);

  // ohSorryRating — ereter 미등록 lv11/lv12 차트 추정값 (추천 풀 fallback)
  // 우선순위: ereter > rating. ereter 매칭 곡은 절대 rating 으로 덮지 않음.
  const [ratingData, setRatingData] = useState<RatingData | null>(null);

  // service-status.json 의 notInINF — INFINITAS 미수록 차트 제외 목록
  const [notInINF, setNotInINF] = useState<NotInInfChart[]>([]);

  // GitHub 최신 릴리즈 체크 결과 — 새 버전 있으면 헤더 배너 노출.
  // 사용자가 "이번 버전 보지 않기" 클릭 시 localStorage 에 dismissed 버전 저장.
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  // v0.0.19+: 포터블 자동 다운로드 state
  const [updateDownload, setUpdateDownload] = useState<{
    stage: 'idle' | 'downloading' | 'done' | 'error';
    downloaded: number;
    total: number;
    filePath?: string;
    error?: string;
  }>({ stage: 'idle', downloaded: 0, total: 0 });

  // 마운트 시: Reflux state 구독 + tsvPath / 현재 state 가져오기.
  //
  // tsv 읽기 정책 (0.0.41 변경):
  //   - 마운트 시 readTsv 호출 안 함 — 옛 stale tsv 가 race condition 으로 보이던 문제 해소.
  //   - 대신 Reflux spawn 완료 (spawned: false → true) 시점에 readTsv 1회 자동 호출.
  //   - 그 후 tracker.tsv 변경 시 실시간 reload effect 가 즉시 갱신 (Supabase 업로드는 주기 timer).
  //
  // 결과: 부팅 직후 잠시 빈 화면 → spawn 완료 (10~30초) 후 자동 채워짐 → 이후 tsv 변경마다 실시간 갱신.
  // (옛 동작: 마운트 즉시 옛 tsv 표시 → race condition 으로 stale 데이터 영구 노출 가능했음)
  const tsvChangedDebounceRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const captureSnapshot = useCallback(async (
    expect: { generation: number; pid: number | null },
    source: 'tsv-changed' | 'retry',
  ): Promise<SnapshotCaptureResult> => {
    if (Date.now() < snapshotBlockUntilRef.current) {
      if (source === 'tsv-changed' && lastSnapshotFreshFailureRef.current !== 'id-switch-cooldown') {
        lastSnapshotFreshFailureRef.current = 'id-switch-cooldown';
        addDiagLine('스냅샷 보류: 계정 전환 직후 Reflux tracker.tsv 안정화 대기 중');
      }
      return { ok: false, reason: 'id-switch-cooldown' };
    }
    try {
      const fresh = await readIidxIdFresh();
      if (!fresh.ok || !fresh.iidxId || !VALID_IIDX_ID.test(fresh.iidxId)) {
        console.warn('[snapshot] skip: fresh id unavailable', fresh);
        if (source === 'tsv-changed') {
          const reportKey = `${freshIdFailureDetail(fresh)} / pid=${expect.pid} gen=${expect.generation}`;
          if (lastSnapshotFreshFailureRef.current !== reportKey) {
            lastSnapshotFreshFailureRef.current = reportKey;
            addDiagLine(`스냅샷 보류: ${reportKey}`);
          }
        }
        return {
          ok: false,
          reason: 'fresh-id-unavailable',
          fresh: { processMissing: fresh.processMissing, error: fresh.error ?? null, iidxId: fresh.iidxId ?? null },
        };
      }
      const viewer = window.infohsorry;
      const expectedSession = { pid: sessionRef.current.pid, generation: sessionRef.current.generation };
      const expectedScope = { ...accountScopeRef.current };
      const capturedProfile = uploadStateRef.current.profile;
      const copiedProfile = {
        ...capturedProfile,
        spRadar: capturedProfile.spRadar ? { ...capturedProfile.spRadar } : capturedProfile.spRadar,
        dpRadar: capturedProfile.dpRadar ? { ...capturedProfile.dpRadar } : capturedProfile.dpRadar,
      };
      const isCurrentCapture = (): boolean => sessionRef.current.pid === expectedSession.pid
        && sessionRef.current.generation === expectedSession.generation
        && isFloorSeedCurrent(expectedScope, accountScopeRef.current)
        && selectedViewerIdRef.current === expectedScope.iidxId;
      const rejectStaleCapture = (): SnapshotCaptureResult => ({ ok: false, reason: 'snapshot-rejected', snapshotReason: 'generation-changed' });
      const res = await viewer.account.snapshot({
        iidxId: fresh.iidxId,
        djName: capturedProfile.iidxId === fresh.iidxId ? capturedProfile.djName ?? null : null,
        profile: copiedProfile,
        expect,
      });
      if (!res.ok || !res.iidxId || res.generation == null || res.tsvMtime == null) {
        console.warn('[snapshot] rejected:', res.reason);
        if (source === 'tsv-changed') addDiagLine(`스냅샷 거부: ${snapshotReasonLabel(res.reason)}`);
        return { ok: false, reason: 'snapshot-rejected', snapshotReason: res.reason };
      }
      if (!isCurrentCapture()) return rejectStaleCapture();
      console.log(`[snapshot] captured id=${res.iidxId} generation=${res.generation} tsvMtime=${res.tsvMtime}`);
      if (!await refreshAccounts(expectedScope)) return rejectStaleCapture();
      if (!isCurrentCapture()) return rejectStaleCapture();
      if (selectedViewerIdRef.current === res.iidxId) {
        const readSeq = ++viewerReadSeqRef.current;
        const t = await viewer.account.readTsv(res.iidxId);
        if (!isCurrentCapture()) return rejectStaleCapture();
        if (t.ok) {
          if (!commitAccountRows(expectedScope, readSeq, expectedSession, t.rows ?? [], t.mtime ?? 0)) return rejectStaleCapture();
        } else {
          console.warn('[snapshot] account.readTsv failed:', t.error);
        }
      }
      if (!isCurrentCapture()) return rejectStaleCapture();
      lastSnapshotRef.current = { iidxId: res.iidxId, generation: res.generation, tsvMtime: res.tsvMtime };
      lastSnapshotFreshFailureRef.current = null;
      if (snapshotRetryTimerRef.current != null) {
        window.clearInterval(snapshotRetryTimerRef.current);
        snapshotRetryTimerRef.current = null;
      }
      // 새 스냅샷마다 마지막 업로드 시각과 비교해 주기가 지났으면 올린다(타이머 없음).
      (window as unknown as { __tryUploadIfDue?: (id: string) => void }).__tryUploadIfDue?.(res.iidxId);
      return { ok: true, iidxId: res.iidxId, generation: res.generation, tsvMtime: res.tsvMtime };
    } catch (err) {
      const error = (err as Error).message;
      console.warn('[snapshot] exception:', error);
      if (source === 'tsv-changed') addDiagLine(`스냅샷 처리 중 오류: ${error}`);
      return { ok: false, reason: 'exception', error };
    }
  }, [commitAccountRows, refreshAccounts]);
  useEffect(() => {
    const offReflux = window.infohsorry.reflux.onState(setRefluxState);
    const viewer = window.infohsorry;
    const offSession = viewer.session.onState(setSession);
    const offTsvChanged = viewer.reflux.onTsvChanged((e: TsvChangedEvent) => {
      console.log(`[tsvChanged] event mtime=${e.mtime} size=${e.size} generation=${e.generation} pid=${e.pid} browserRemote=${IS_BROWSER_REMOTE}`);
      if (IS_BROWSER_REMOTE) return;
      if (tsvChangedDebounceRef.current) clearTimeout(tsvChangedDebounceRef.current);
      tsvChangedDebounceRef.current = window.setTimeout(() => void captureSnapshot(
        { generation: e.generation, pid: e.pid },
        'tsv-changed',
      ), 400);
    });
    void (async () => {
      // 목록 갱신이 더 최신 요청에 밀려도(false) 마지막 선택 계정 로드는 진행한다 — 목록은 최신 요청이 채운다.
      const [s, path, , lastSelected] = await Promise.all([viewer.session.getState(), window.infohsorry.reflux.getTsvPath(), refreshAccounts(), viewer.account.getLastSelected()]);
      setSession(s); setRefluxState(await window.infohsorry.reflux.getState()); setTsvPath(path);
      if (s.pid == null && lastSelected) void loadViewerAccount(lastSelected);
    })();
    return () => {
      offReflux(); offSession(); offTsvChanged();
      if (tsvChangedDebounceRef.current) clearTimeout(tsvChangedDebounceRef.current);
    };
  }, [captureSnapshot, loadViewerAccount, refreshAccounts]);


  useEffect(() => {
    void (async () => {
      const status = await window.infohsorry.ereter.status();
      setEreterStatus(status);
      if (status.isStale || !status.exists) {
        await refreshEreter(false);
      } else {
        const r = await window.infohsorry.ereter.get(false);
        if (r.ok && r.data) setEreterData(r.data);
      }
    })();
  }, []);

  // 마운트 시 zasa 보충 데이터 자동 fetch (실패해도 무시 — DP12 격자 미분류 fallback 만 영향)
  useEffect(() => {
    void (async () => {
      try {
        const r = await window.infohsorry.zasa.get(false);
        if (r.ok && r.data) setZasaData(r.data);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // 마운트 시 ohSorryRating 자동 fetch (실패해도 무시 — 추천 풀 fallback 만 영향)
  useEffect(() => {
    void (async () => {
      try {
        const r = await window.infohsorry.rating.get(false);
        if (r.ok && r.data) setRatingData(r.data);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // 마운트 시 SP ☆12 서열표 자동 fetch (실패해도 무시 — SP12 탭만 영향)
  useEffect(() => {
    void (async () => {
      try {
        const r = await window.infohsorry.spTier.get(false);
        if (r.ok && r.data) setSpTierData(r.data);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // 마운트 시 service-status.json fetch — notInINF (INFINITAS 미수록 차트 제외 목록).
  // 실패해도 무시 — 목록 없으면 필터 미적용 (기존 동작 유지).
  useEffect(() => {
    void (async () => {
      try {
        const s = await window.infohsorry.serviceStatus.get();
        if (Array.isArray(s.notInINF)) setNotInINF(s.notInINF);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // GitHub 최신 릴리즈 체크 — 마운트 5초 후 1회 + 이후 10분마다 반복.
  // 실패 / 네트워크 끊김 / 같은 버전이면 배너 안 뜸. 업데이트 배너를 띄우면 폴링 중단.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const check = async (): Promise<void> => {
      try {
        const info = await window.infohsorry.update.check();
        if (info.hasUpdate && info.latestVersion) {
          const dismissed = localStorage.getItem('infohsorry.update.dismissed');
          if (dismissed !== info.latestVersion) {
            setUpdateInfo(info);
            // 배너를 띄웠으면 더 폴링할 필요 없음 — interval 정리
            if (interval) {
              clearInterval(interval);
              interval = null;
            }
          }
        }
      } catch {
        /* ignore */
      }
    };
    // 초기 로딩 우선 — 5초 지연 후 첫 체크, 그 다음 10분 간격 반복
    const t = setTimeout(() => {
      void check();
      interval = setInterval(() => void check(), 10 * 60 * 1000);
    }, 5000);
    return () => {
      clearTimeout(t);
      if (interval) clearInterval(interval);
    };
  }, []);

  // ereter 갱신 — force=true 면 24h 안 지났어도 강제 갱신
  async function refreshEreter(force: boolean): Promise<void> {
    setEreterBusy(true);
    try {
      const r = await window.infohsorry.ereter.get(force);
      if (!r.ok) setError(r.error || 'ereter 갱신 실패');
      else if (r.data) setEreterData(r.data);
      const updated = await window.infohsorry.ereter.status();
      setEreterStatus(updated);
    } catch (e) {
      setError(`ereter: ${(e as Error).message}`);
    } finally {
      setEreterBusy(false);
    }
  }

  // tracker.tsv 실시간 재읽기 — Reflux 가 mtime 변경을 감지하면(watchTsv → onState) 즉시 reload.
  //   "읽기는 실시간, Supabase 업로드는 주기적" 분리 정책. 업로드/vec 는 아래 스케줄 timer(초기 3분→15분) 가 담당.
  //   (0.0.41~0.0.75 에선 race 우려로 이 이벤트 reload 를 끄고 timer 로만 읽었으나, 실시간성 위해 부활.

  async function startReflux(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await window.infohsorry.reflux.start();
      if (!r.ok) setError(r.error || 'Reflux 시작 실패');
    } finally {
      setBusy(false);
    }
  }

  // Reflux on/off 토글 — 헤더의 ⏻ 버튼
  async function toggleReflux(): Promise<void> {
    const isRunning =
      refluxState.stage !== 'idle' && refluxState.stage !== 'error';
    if (isRunning) {
      try {
        await window.infohsorry.reflux.stop();
      } catch (e) {
        setError((e as Error).message);
      }
    } else {
      void startReflux();
    }
  }

  // SP/DP 탭의 통계
  const stats = useMemo(() => {
    if (tab === 'dp12' || tab === 'recent' || tab === 'analysis' || tab === 'playdata' || tab === 'grid') return { total: 0, unlocked: 0, played: 0 };
    const slots = tab === 'sp' ? ['SPB', 'SPN', 'SPH', 'SPA', 'SPL'] : ['DPN', 'DPH', 'DPA', 'DPL'];
    let unlocked = 0;
    let played = 0;
    let total = 0;
    for (const r of rows) {
      for (const s of slots) {
        const cell = r.charts[s as keyof typeof r.charts];
        if (!cell) continue;
        total++;
        if (cell.unlocked) unlocked++;
        if (cell.unlocked && cell.lamp && cell.lamp !== 'NP') played++;
      }
    }
    return { total, unlocked, played };
  }, [rows, tab]);

  // INFINITAS 미수록 차트 제외 Set — service-status.json 의 notInINF 기반. key: norm(title)+'|'+slot
  //   diff 는 slot(DPL/SPL …) 콤마 다중 지원 ("DPL,SPL" → 한 곡 두 채보) — 이중 항목 없이 한 줄로.
  const notInInfSet = useMemo(() => {
    const s = new Set<string>();
    for (const e of notInINF) {
      if (!e?.title || !e?.diff) continue;
      for (const tok of String(e.diff).split(',')) {
        const slot = tok.trim().toUpperCase();
        if (slot) s.add(norm(e.title) + '|' + slot);
      }
    }
    return s;
  }, [notInINF]);

  // DP ☆12 차트 추출 — 서열표 input
  // 매칭 우선순위: ereter ★ → ohSorryRating (gameLevel===12) zasaLevel (둘 다 없으면 미분류).
  // ratingMap 만 매칭된 차트는 추천 / ★값 추정엔 사용 X — 격자 분류만 영향.
  // notInInfSet (INFINITAS 미수록) 곡은 추출 단계에서 제외.
  const dp12Charts = useMemo(() => {
    const charts = extractCharts(rows, { slots: DP_SLOTS, level: 12 }).filter(
      (c) => !notInInfSet.has(norm(c.title) + '|' + c.slot),
    );
    if (!ereterData && !ratingData && !zasaData) return charts;
    const ereterIdx = ereterData ? buildEreterIndex(ereterData.charts).index : null;
    // ohSorryRating (lv12) 인덱스 — norm(title)+'|'+diff → zasaLevel
    const ratingIdx12 = new Map<string, number>();
    if (ratingData) {
      for (const r of ratingData.ratings) {
        if (r.gameLevel !== 12) continue;
        ratingIdx12.set(norm(r.title) + '|' + r.diff, r.zasaLevel);
      }
    }
    // zasa-data 인덱스 — ereter / ratingMap 둘 다 없는 미분류 곡 fallback
    const zasaIdx = new Map<string, number>();
    if (zasaData) {
      for (const z of zasaData.charts) {
        zasaIdx.set(norm(z.title) + '|' + z.diff, z.level);
      }
    }
    return charts.map((c) => {
      const key = norm(c.title) + '|' + slotToDiff(c.slot);
      const e = ereterIdx?.get(key);
      if (e) return { ...c, ereterLevel: e.level };
      const lv = ratingIdx12.get(key);
      if (typeof lv === 'number') return { ...c, ereterLevel: lv };
      const zlv = zasaIdx.get(key);
      if (typeof zlv === 'number') return { ...c, ereterLevel: zlv };
      return c;
    });
  }, [rows, ereterData, ratingData, zasaData, notInInfSet]);

  // DP ☆11 차트 추출 — ohSorryRating.ratings (gameLevel === 11) 의 zasaLevel 매칭
  //   ereter 는 ★12 만 등재 → lv11 격자는 ohSorryRating 의 zasaLevel 로 그룹화
  const dp11Charts = useMemo(() => {
    const charts = extractCharts(rows, { slots: DP_SLOTS, level: 11 }).filter(
      (c) => !notInInfSet.has(norm(c.title) + '|' + c.slot),
    );
    if (!ratingData && !zasaData) return charts;
    const ratingIdx = new Map<string, number>(); // key → zasaLevel
    if (ratingData) {
      for (const r of ratingData.ratings) {
        if (r.gameLevel !== 11) continue;
        ratingIdx.set(norm(r.title) + '|' + r.diff, r.zasaLevel);
      }
    }
    // zasa-data 인덱스 — ratingMap 에 없는 미분류 곡 fallback
    const zasaIdx = new Map<string, number>();
    if (zasaData) {
      for (const z of zasaData.charts) {
        zasaIdx.set(norm(z.title) + '|' + z.diff, z.level);
      }
    }
    return charts.map((c) => {
      const key = norm(c.title) + '|' + slotToDiff(c.slot);
      const lv = ratingIdx.get(key);
      if (typeof lv === 'number') return { ...c, ereterLevel: lv };
      const zlv = zasaIdx.get(key);
      if (typeof zlv === 'number') return { ...c, ereterLevel: zlv };
      return c;
    });
  }, [rows, ratingData, zasaData, notInInfSet]);

  // SP ☆12 차트 추출 — SP 서열표(spTierData) 매칭 input.
  //   INFINITAS 미수록 곡은 제외. tier 분류는 DpTable 안에서 spTierData 로 수행.
  const sp12Charts = useMemo(
    () =>
      extractCharts(rows, { slots: SP_SLOTS, level: 12 }).filter(
        (c) => !notInInfSet.has(norm(c.title) + '|' + c.slot),
      ),
    [rows, notInInfSet],
  );

  // 원격모드 SP — 친 모든 SP 채보(전 레벨/시리즈, 플레이한 것만). /api/me 의 sp_charts_json 으로 실어
  //   오소리웹 카드가 SP 모드 PlayData/연습추천/통계에 사용. (미플레이는 제외 — payload 축소, 폴더는 textage 로 채움.)
  const spAllCharts = useMemo(
    () =>
      extractCharts(rows, { slots: SP_SLOTS }).filter(
        (c) => lampNum(c.lamp) > 0 || c.exScore > 0,
      ),
    [rows],
  );

  // 전체 플레이 DP 채보 (전 레벨/전 시리즈, 플레이한 것만) — supabase scores 적재용(play_style:1, 전 레벨).
  //   dp12Match(lv11/12, 레이팅 매칭) 경로와 별개로 저레벨 DP 까지 커버. INFINITAS 미수록(notInInf) 채보는
  //   제외 — INF 점수(played_version=0)로 잘못 적재되지 않게. lv11/12 는 dp12Match 와 겹치나 업로더 dedup 이 병합.
  const dpAllCharts = useMemo(
    () =>
      extractCharts(rows, { slots: DP_SLOTS }).filter(
        (c) =>
          (lampNum(c.lamp) > 0 || c.exScore > 0) &&
          !notInInfSet.has(norm(c.title) + '|' + c.slot),
      ),
    [rows, notInInfSet],
  );

  // TSV 전곡(DP+SP 전 난이도/전 레벨, 플레이 무관) — songs 마스터 "곡 존재" 등록용.
  //   INFINITAS 미수록(notInInf) 채보는 제외 — INF 플래그가 잘못 붙지 않게.
  //   미플레이 신곡도 songs 에 남겨, 플레이 없이도 다른 유저/목록에 곡이 노출되도록 함.
  const allTsvCharts = useMemo(
    () =>
      extractCharts(rows, { slots: [...DP_SLOTS, ...SP_SLOTS] }).filter(
        (c) => !notInInfSet.has(norm(c.title) + '|' + c.slot),
      ),
    [rows, notInInfSet],
  );

  // 서열표 미분류 곡 JSON payload — ereter / ratingMap / zasaData 셋 다 매칭 안 된 곡 (lv11+lv12).
  const unclassifiedJson = useMemo(() => {
    const toEntry = (c: typeof dp12Charts[number], gameLevel: 11 | 12) => {
      const diff = slotToDiff(c.slot);
      return {
        title: c.title,
        diff,
        slot: c.slot,
        gameLevel,
        lamp: c.lamp,
        unlocked: c.unlocked,
        normKey: norm(c.title) + '|' + diff,
      };
    };
    const lv12Unclassified = dp12Charts.filter((c) => c.ereterLevel == null).map((c) => toEntry(c, 12));
    const lv11Unclassified = dp11Charts.filter((c) => c.ereterLevel == null).map((c) => toEntry(c, 11));
    return {
      generatedAt: new Date().toISOString(),
      summary: { lv12Count: lv12Unclassified.length, lv11Count: lv11Unclassified.length },
      lv12Unclassified,
      lv11Unclassified,
    };
  }, [dp12Charts, dp11Charts]);

  // INFINITAS DP 차트 풀 — **ohSorryRating.json (ratingData) 등재곡 기준**.
  //
  // 변경 (2026-05-14): 풀 자체를 ratingData 의 lv11/12 곡으로 한정.
  //   - 내부 추천 평가용 (level/ec/hc/exh) = ratingMap 의 zasaLevel / estEc / estHc / estExh
  //   - 표시용 ereter 실측 (ereterLevel/Ec/Hc/Exh) = 별도 필드로 저장 (있을 때만)
  //   - ratingData 미등재 곡 (신곡 등) 은 풀에서 제외 — supabase 업로드용은 별도 newSongCharts 분리
  //
  // 매칭 흐름:
  //   ratingData.ratings → tsv (Reflux) row 매칭 → ereter 보조 매칭
  const dp12Match = useMemo(() => {
    if (!ratingData) return null;  // 풀 기준 자체가 ratingData
    const ereterIdx = ereterData ? buildEreterIndex(ereterData.charts).index : new Map();
    // zasa-data lookup
    const zasaIdx = new Map<string, number>();
    const zasaGLIdx = new Map<string, number>();  // 변종 가드용 — norm|diff → 그 zasa 엔트리(=AC 채보)의 gameLevel
    if (zasaData) {
      for (const z of zasaData.charts) {
        zasaIdx.set(norm(z.title) + '|' + z.diff, z.level);
        if (typeof z.gameLevel === 'number') zasaGLIdx.set(norm(z.title) + '|' + z.diff, z.gameLevel);
      }
    }
    // tsv (Reflux row) index: normKey → { title, slot, c, type, label }
    type TsvHit = {
      title: string;
      slot: ChartSlot;
      diff: string;
      c: NonNullable<(typeof rows)[number]['charts'][ChartSlot]>;
      type: string | null;
      label: string | null;
    };
    const tsvIdx = new Map<string, TsvHit>();
    for (const r of rows) {
      for (const slot of DP_SLOTS) {
        const c = r.charts[slot];
        if (!c) continue;
        // lv 필터 제거 — 전 레벨 차트를 supabase scores 에 업로드 (unclassifiedCharts 경로).
        // m.charts (dp12Match) 는 ratingData.ratings 의 gameLevel===11||12 필터로 별도 제한.
        const diff = slotToDiff(slot);
        const normKey = norm(r.title) + '|' + diff;
        tsvIdx.set(normKey, { title: r.title, slot, diff, c, type: r.type ?? null, label: r.label ?? null });
      }
    }

    const charts: RecInputChart[] = [];
    let matched = 0;          // ratingData ∩ tsv ∩ ereter (3중 매칭)
    let ratingOnlyCount = 0;  // ratingData ∩ tsv (ereter 미등재 — isRatingFallback=true)
    let ratingMissCount = 0;  // ratingData 에 있지만 tsv 미매칭 (잠금/신곡 미반영)
    // 미매칭 진단 — tsv 와 ratingData 간 불일치 목록 (JSON 내보내기용)
    const ratingMissedInTsv: { title: string; diff: string; gameLevel: number; zasaLevel: number; normKey: string }[] = [];
    const ratingKeyset = new Set<string>();
    for (const rt of ratingData.ratings) {
      if (rt.gameLevel !== 11 && rt.gameLevel !== 12) continue;
      if (typeof rt.zasaLevel !== 'number' || rt.zasaLevel > 12.7) continue;
      const normKey = norm(rt.title) + '|' + rt.diff;
      const hit = tsvIdx.get(normKey);
      // 변종(AC≠INF) 가드 — INFINITAS 유저 TSV 채보(INF/구)의 in-game level 이 AC rating 의 gameLevel 과
      //   다르면 = INF 채보 → AC rating/zasa 부착 금지(continue). ratingKeyset 에 안 넣어 아래 미분류로 떨어진다.
      //   비변종/AC(레벨 일치)는 영향 없음. (예: ミッドナイト ANOTHER INF★9 가 AC★12 rating 을 물지 않게)
      if (hit && isVariantTitle(rt.title) && hit.c.level !== rt.gameLevel) continue;
      ratingKeyset.add(normKey);
      if (!hit) {
        ratingMissCount++;
        ratingMissedInTsv.push({ title: rt.title, diff: rt.diff, gameLevel: rt.gameLevel, zasaLevel: rt.zasaLevel, normKey });
        continue;
      }
      // INFINITAS 미수록 차트 — 추천 / 서열표 / supabase 모두에서 제외
      if (notInInfSet.has(norm(rt.title) + '|' + hit.slot)) continue;
      const c = hit.c;
      const e = ereterIdx.get(normKey);
      const hasEreter = !!e && e.level <= 12.7;
      if (hasEreter) matched++;
      else ratingOnlyCount++;
      charts.push({
        title: hit.title,
        slot: hit.slot,
        diff: hit.diff,
        // 내부 추천 평가용 — ratingMap estimates
        level: rt.zasaLevel,
        ec: typeof rt.estEc === 'number' ? rt.estEc : null,
        hc: typeof rt.estHc === 'number' ? rt.estHc : null,
        exh: typeof rt.estExh === 'number' ? rt.estExh : null,
        ec_n: typeof rt.nEcCleared === 'number' ? rt.nEcCleared : null,
        hc_n: typeof rt.nHcCleared === 'number' ? rt.nHcCleared : null,
        exh_n: 0,
        // 사용자 플레이
        lamp: c.lamp,
        lampNum: lampNum(c.lamp),
        djLevel: c.letter || null,
        missCount: typeof c.missCount === 'number' ? c.missCount : null,
        // ereter 실측 (있을 때만)
        ereterLevel: hasEreter ? e.level : null,
        ereterEc: hasEreter ? e.ec : null,
        ereterHc: hasEreter ? e.hc : null,
        ereterExh: hasEreter ? e.exh : null,
        ereterEcN: hasEreter ? e.ec_n : null,
        ereterHcN: hasEreter ? e.hc_n : null,
        ereterExhN: hasEreter ? e.exh_n : null,
        gameLevel: rt.gameLevel,
        zasaLevel: zasaIdx.get(normKey) ?? rt.zasaLevel,
        isRatingFallback: !hasEreter,  // ereter 미등재 → UI 색 구분 + 표시 fallback
        unlocked: c.unlocked,
        exScore: typeof c.exScore === 'number' ? c.exScore : null,
        noteCount: typeof c.noteCount === 'number' ? c.noteCount : null,
        djPoints: typeof c.djPoints === 'number' ? c.djPoints : null,
        songType: hit.type,
        songLabel: hit.label,
      });
    }

    // 진단용 — supabase 업로드 / 신곡 추정 등에서 쓰일 수 있는 "tsv 에 있는데 ratingData 미등재" 목록
    // 추천 풀과는 분리. 잠금 해제 + 플레이된 곡 한정.
    // tsv 에 있는데 ratingData 에 없는 lv11/12 곡 (신곡 / 풀에서 빠짐) 목록 수집
    const tsvMissedInRating: { title: string; diff: string; gameLevel: number; lamp: string; normKey: string }[] = [];
    // 서열표 '미분류' 표시용 — ratingData 미등재지만 플레이한 lv11/12 곡.
    // 추천 풀 / ★ 추정엔 미포함, supabase charts_json 업로드에만 m.charts 와 합쳐짐.
    // level (rating zasaLevel 추정치) 은 없음 → 게스트 서열표는 zasaLevel fallback → 미분류/zasa★ 그룹.
    const unclassifiedCharts: Omit<RecInputChart, 'level'>[] = [];
    for (const [key, hit] of tsvIdx) {
      if (ratingKeyset.has(key)) continue;
      if (notInInfSet.has(norm(hit.title) + '|' + hit.slot)) continue; // INFINITAS 미수록 제외
      tsvMissedInRating.push({ title: hit.title, diff: hit.diff, gameLevel: hit.c.level, lamp: hit.c.lamp, normKey: key });
      const c = hit.c;
      unclassifiedCharts.push({
        title: hit.title,
        slot: hit.slot,
        diff: hit.diff,
        ec: null,
        hc: null,
        exh: null,
        ec_n: null,
        hc_n: null,
        exh_n: 0,
        lamp: c.lamp,
        lampNum: lampNum(c.lamp),
        djLevel: c.letter || null,
        missCount: typeof c.missCount === 'number' ? c.missCount : null,
        ereterLevel: null,
        ereterEc: null,
        ereterHc: null,
        ereterExh: null,
        ereterEcN: null,
        ereterHcN: null,
        ereterExhN: null,
        gameLevel: hit.c.level,
        // 변종(AC≠INF): zasa-data 는 AC 채보만 수록 → 유저 INF 채보의 in-game level 이 zasa 엔트리(AC)의
        //   gameLevel 과 다르면 AC zasa★ 를 물지 않게 null. 비변종/같은 레벨은 기존대로.
        zasaLevel: (isVariantTitle(hit.title) && zasaGLIdx.get(key) !== hit.c.level)
          ? null : (zasaIdx.get(key) ?? null),
        isRatingFallback: true,
        unlocked: c.unlocked,
        exScore: typeof c.exScore === 'number' ? c.exScore : null,
        noteCount: typeof c.noteCount === 'number' ? c.noteCount : null,
        djPoints: typeof c.djPoints === 'number' ? c.djPoints : null,
        songType: hit.type,
        songLabel: hit.label,
      });
    }

    const unmatched: number = ratingMissCount + tsvMissedInRating.length;
    const unmatchedSamples: string[] = tsvMissedInRating.slice(0, 5).map((u) => `${u.title} [${u.diff}]`);
    const unmatchedAll: { title: string; diff: string; lamp: string; normKey: string; ereterCandidates: string[] }[] = [];
    // 미매칭 곡 JSON 내보내기용 payload
    const ratingUnmatchedJson = {
      generatedAt: new Date().toISOString(),
      summary: {
        ratingPoolSize: ratingKeyset.size,
        tsvPoolSize: tsvIdx.size,
        tsvOnlyCount: tsvMissedInRating.length,
        ratingOnlyCount: ratingMissedInTsv.length,
      },
      tsvOnly: tsvMissedInRating,    // tsv 에 있는데 ratingData 에 없는 곡
      ratingOnly: ratingMissedInTsv, // ratingData 에 있는데 tsv 에 없는 곡
    };

    console.log(`[dp12Match] 풀=${charts.length}곡 (ratingData 등재). 3중매칭=${matched}, ereter 미등재=${ratingOnlyCount}, tsv 미반영=${ratingMissCount}, tsv-only=${tsvMissedInRating.length}`);
    return { charts, unclassifiedCharts, matched, unmatched, unmatchedSamples, unmatchedAll, ratingUnmatchedJson };
  }, [rows, ereterData, ratingData, zasaData, notInInfSet]);

  // 별값 lib 입력 — SongRow / DP_SLOTS → { title, diff, lampNum } 단순 형식.
  //   onlyOSRtoEreter.inferEreter 의 charts 인자로 그대로 사용 (lampNum 0/2 필터는 lib 내부 처리).
  // 별값 입력 누적(monotonic) — 한 번 본 클리어(lamp)는 메모리 덤프가 순간 누락해도 빼지 않는다.
  //   Reflux 덤프가 일부 채보 unlock/lamp 를 순간 0 으로 읽어 별값(전체곡 50% native)이 5.49~5.6 으로 흔들리던 wobble 제거.
  //   key=title|diff, 값=세션 최대 lampNum. DB make_grid_data 도 lamp_best(채보별 최대 lamp) 라 산식 일치 → 같은 값(5.6)으로 수렴.
  //   ⚠ 유저(iidx_id) 전환/세션 리셋 시 반드시 clear(아래 doReset) — 안 그러면 이전 유저 클리어가 섞여 별값 오염.
  const osrInputCacheRef = useRef<{ owner: string | null; input: { title: string; diff: string; lampNum: number }[] } | null>(null);
  const osrChartsInput = useMemo(() => {
    if (!isFloorSeedCurrent(rowsState.scope, osrAccumScopeRef.current)) {
      osrAccumRef.current.clear();
      osrAccumScopeRef.current = { ...rowsState.scope };
    }
    // 현재 rows 의 클리어를 누적 맵에 merge(max). 순간 누락은 무시되고 새 클리어/상위 lamp 만 반영 → 아래로 안 흔들림.
    for (const r of rows) {
      for (const slot of DP_SLOTS) {
        const cell = r.charts[slot];
        if (!cell || !cell.unlocked || !cell.lamp) continue;
        const diff = slotToDiff(slot);
        if (!diff) continue;
        const key = r.title + '|' + diff;
        const ln = lampNum(cell.lamp);
        const prev = osrAccumRef.current.get(key);
        if (!prev || ln > prev.lampNum) osrAccumRef.current.set(key, { title: r.title, diff, lampNum: ln });
      }
    }
    const input = reuseOsrInput(osrInputCacheRef.current, rowsOwnerId, Array.from(osrAccumRef.current.values()));
    osrInputCacheRef.current = { owner: rowsOwnerId, input };
    return input;
  }, [rows, rowsState.scope.iidxId, rowsState.scope.epoch]);

  // Worker input preserves the account-owned cumulative OSR lamps.
  const workerInput = useMemo(() => rendererInput(rowsState.scope, rowsRevisionRef.current, {
    rows, osrCharts: osrChartsInput, notInInf: Array.from(notInInfSet), songs: [],
  }), [rows, osrChartsInput, notInInfSet, rowsState.scope.iidxId, rowsState.scope.epoch]);
  const dpResources = useSnapshotResources('dp-star', { rating: ratingData, ereter: ereterData });
  const analysisCharts = useMemo(() => [...dp12Charts, ...dp11Charts], [dp12Charts, dp11Charts]);
  const analysisInput = useMemo(() => rendererInput(rowsState.scope, rowsRevisionRef.current, {
    rows, osrCharts: [], notInInf: [], songs: null, analysisCharts,
  }), [rows, analysisCharts, rowsState.scope.iidxId, rowsState.scope.epoch]);
  const rResources = useSnapshotResources('r-star', { rating: ratingData });
  const spResources = useSnapshotResources('sp-star', {});
  const workerCurrent = () => isFloorSeedCurrent(workerInput.stamp.scope, accountScopeRef.current)
    && isFloorSeedCurrent(workerInput.stamp.scope, rowsScopeRef.current)
    && selectedViewerIdRef.current === workerInput.stamp.scope.iidxId
    && rowsRevisionRef.current === workerInput.stamp.rowsRevision;
  const raiseFloor = (key: 'starFloor' | 'rStarFloor', value: number | null | undefined) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || !workerCurrent()) return;
    const scope = workerInput.stamp.scope;
    if (key === 'starFloor' ? starFloor == null || value > starFloor : rStarFloor == null || value > rStarFloor) {
      uploadStateRef.current.bundleReady = false;
    }
    setFloorState(f => !workerCurrent() || !isFloorSeedCurrent(scope, f.scope)
      ? f : f[key] == null || value > f[key]! ? { ...f, [key]: value } : f);
  };
  const dpTask = useComputeTask<StarResult>('dp-star', workerInput, { prevStar: starFloor },
    dpResources, !!ratingData && !!ereterData, workerCurrent, value => raiseFloor('starFloor', value?.star));
  const rTask = useComputeTask<number>('r-star', workerInput, { prevRStar: rStarFloor },
    rResources, !!ratingData, workerCurrent, value => raiseFloor('rStarFloor', value));
  const spTask = useComputeTask<SpSkillResult>('sp-star', workerInput, {},
    spResources, true, workerCurrent);
  const dp12StarResult = dpTask.value;
  const userRStar = rTask.value;
  const spStarResult = spTask.value;
  const acceptedStars = starBundle(workerInput, dpTask.task, rTask.task, spTask.task);
  const bundleReady = acceptedStars.ready && workerCurrent();

  const ohsorryRecBase = useMemo(() => dp12StarResult?.star ?? null, [dp12StarResult]);

  // 프로필 (DJ NAME / IIDX ID / SP / DP rank) — 메모리에서 polling
  const profile = useProfile(refluxState);
  const analysisLive = useRef({ input: analysisInput, profileId: profile.iidxId });
  analysisLive.current = { input: analysisInput, profileId: profile.iidxId };
  const analysisCurrent = () => analysisLive.current.input === analysisInput
    && isFloorSeedCurrent(analysisInput.stamp.scope, accountScopeRef.current)
    && isFloorSeedCurrent(analysisInput.stamp.scope, rowsScopeRef.current)
    && selectedViewerIdRef.current === analysisInput.stamp.scope.iidxId
    && rowsRevisionRef.current === analysisInput.stamp.rowsRevision
    && analysisLive.current.profileId?.replace(/-/g, '') === analysisInput.stamp.scope.iidxId?.replace(/-/g, '');
  const liveIidxId = session.pid != null && profile.iidxId && VALID_IIDX_ID.test(profile.iidxId) ? profile.iidxId : null;
  const clearLiveSessionState = useCallback(() => {
    lastSnapshotRef.current = null;
    invalidateAccountScope(selectedViewerIdRef.current, false);
  }, [invalidateAccountScope]);
  const prevSessionRef = useRef<InfinitasSessionState | null>(null);
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev && (prev.pid !== session.pid || prev.generation !== session.generation)) {
      clearLiveSessionState();
      void refreshAccounts();
    }
    prevSessionRef.current = session;
  }, [session, clearLiveSessionState, refreshAccounts]);
  useEffect(() => {
    const stopRetryTimer = (): void => {
      if (snapshotRetryTimerRef.current != null) {
        window.clearInterval(snapshotRetryTimerRef.current);
        snapshotRetryTimerRef.current = null;
      }
    };
    const currentSession = sessionRef.current;
    if (IS_BROWSER_REMOTE || currentSession.pid == null || rowsRef.current.length === 0 || (lastSnapshotRef.current != null && lastSnapshotRef.current.generation === currentSession.generation)) {
      stopRetryTimer();
      return;
    }
    const previousRetrySession = snapshotRetrySessionRef.current;
    if (!previousRetrySession || previousRetrySession.pid !== currentSession.pid || previousRetrySession.generation !== currentSession.generation) {
      snapshotRetrySessionRef.current = { pid: currentSession.pid, generation: currentSession.generation };
      snapshotRetryFailuresRef.current = 0;
      lastSnapshotRetryReportRef.current = null;
    }
    const retry = async (): Promise<void> => {
      const retrySession = sessionRef.current;
      if (retrySession.pid == null || rowsRef.current.length === 0 || (lastSnapshotRef.current != null && lastSnapshotRef.current.generation === retrySession.generation)) {
        stopRetryTimer();
        return;
      }
      const result = await captureSnapshot({ generation: retrySession.generation, pid: retrySession.pid }, 'retry');
      const liveSession = sessionRef.current;
      if (liveSession.pid !== retrySession.pid || liveSession.generation !== retrySession.generation) return;
      if (result.ok) {
        const retryCount = snapshotRetryFailuresRef.current + 1;
        snapshotRetryFailuresRef.current = 0;
        lastSnapshotRetryReportRef.current = null;
        addDiagLine(`업로드 준비 완료 — 스냅샷 확보(재시도 ${retryCount}회)`);
        stopRetryTimer();
        return;
      }
      snapshotRetryFailuresRef.current += 1;
      if (snapshotRetryFailuresRef.current < SNAPSHOT_RETRY_REPORT_AFTER) return;
      let detail: string;
      if (result.reason === 'id-switch-cooldown') {
        detail = '계정 전환 직후 Reflux tracker.tsv 안정화 대기 중';
      } else if (result.reason === 'fresh-id-unavailable') {
        detail = freshIdFailureDetail(result.fresh);
      } else if (result.reason === 'snapshot-rejected') {
        detail = `스냅샷 거부: ${snapshotReasonLabel(result.snapshotReason)}`;
      } else {
        detail = `스냅샷 처리 중 오류: ${result.error}`;
      }
      const reportKey = `${detail} / pid=${retrySession.pid} gen=${retrySession.generation}`;
      if (lastSnapshotRetryReportRef.current === reportKey) return;
      lastSnapshotRetryReportRef.current = reportKey;
      addDiagLine(`업로드 준비 실패(${snapshotRetryFailuresRef.current}회) — ${reportKey}`);
    };
    snapshotRetryTimerRef.current = window.setInterval(() => void retry(), SNAPSHOT_RETRY_INTERVAL_MS);
    return stopRetryTimer;
  }, [captureSnapshot, session.pid, session.generation, rows.length]);
  useEffect(() => {
    if (!rowsOwnerId || rows.length === 0 || selectedViewerId !== rowsOwnerId) {
      setUserPublic({ dpRadar: null, star: null, rStar: null, spRank: null, dpRank: null });
      setUserPublicScope(null);
      return;
    }
    let cancelled = false;
    const request = { ...rowsState.scope };
    if (!isFloorSeedCurrent(request, accountScopeRef.current)) return;
    fetchUserPublic(rowsOwnerId).then((r) => {
      if (cancelled || !isFloorSeedCurrent(request, accountScopeRef.current)) return;
      setUserPublic(r);
      setUserPublicScope(request);
      // 저장된 별값을 래칫 하한으로 채택 (다른 세션/본체 크롤로 올라간 값 반영).
      setFloorState((f) => {
        if (cancelled || !isFloorSeedCurrent(request, accountScopeRef.current) || !isFloorSeedCurrent(request, f.scope)) return f;
        const star = r.star;
        const rStar = r.rStar;
        return {
          ...f,
          starFloor: typeof star === 'number' && Number.isFinite(star) && (f.starFloor == null || star > f.starFloor) ? star : f.starFloor,
          rStarFloor: typeof rStar === 'number' && Number.isFinite(rStar) && (f.rStarFloor == null || rStar > f.rStarFloor) ? rStar : f.rStarFloor,
        };
      });
    }).catch((err) => {
      if (cancelled || !isFloorSeedCurrent(request, accountScopeRef.current)) return;
      setUserPublic({ dpRadar: null, star: null, rStar: null, spRank: null, dpRank: null });
      setUserPublicScope(null);
      console.warn('[viewer] fetchUserPublic failed:', err);
    });
    return () => { cancelled = true; };
  }, [rowsOwnerId, rowsState.scope.epoch, rows.length > 0, selectedViewerId]);
  const currentUserPublic = userPublicScope && selectedViewerId === rowsOwnerId
    && isFloorSeedCurrent(userPublicScope, rowsState.scope)
    && isFloorSeedCurrent(userPublicScope, accountScopeRef.current)
    ? userPublic : { dpRadar: null, star: null, rStar: null, spRank: null, dpRank: null };

  // ProfileCard 에 넘길 레이더 / 단위 — 게임 메모리 값이 있으면 그걸 쓰고, 없을 때만 supabase 저장값.
  //   메모리 = 지금 이 계정의 실시간 값 (SP/DP 둘 다), supabase = eagate 배치 스냅샷 (DP 만).
  // 선택 계정 TSV를 기본으로 표시하고, 같은 ID의 live 값만 null이 아닌 항목별로 우선한다.
  const cardId = selectedViewerId;
  const cardMeta = cardId ? accounts.find((entry) => entry.iidxId === cardId) ?? null : null;
  const sameLive = cardId != null && session.pid != null && profile.iidxId === cardId;
  const cardBase = cardId ? resolveAccountSnapshotProfile(cardId, cardMeta, sameLive ? profile : null) : null;
  const formattedCardId = cardId ? `${cardId[0]}-${cardId.slice(1, 5)}-${cardId.slice(5, 9)}-${cardId.slice(9)}` : null;
  const emptyCardProfile: ProfileInfo = {
    djName: cardMeta?.djName ?? null, iidxId: cardId, iidxIdFormatted: formattedCardId,
    spRank: cardMeta?.spRank ?? null, dpRank: cardMeta?.dpRank ?? null,
    spRankInt: cardMeta?.spRankInt ?? null, dpRankInt: cardMeta?.dpRankInt ?? null,
    spRadar: cardMeta?.spRadar ?? null, dpRadar: cardMeta?.dpRadar ?? null,
  };
  const cardProfile: ProfileInfo = cardId ? {
    ...emptyCardProfile,
    ...(cardBase ?? {}),
    ...(sameLive ? {
      djName: profile.djName ?? cardBase?.djName ?? emptyCardProfile.djName,
      spRank: profile.spRank ?? cardBase?.spRank ?? null,
      dpRank: profile.dpRank ?? cardBase?.dpRank ?? null,
      spRankInt: profile.spRankInt ?? cardBase?.spRankInt ?? null,
      dpRankInt: profile.dpRankInt ?? cardBase?.dpRankInt ?? null,
      spRadar: profile.spRadar ?? cardBase?.spRadar ?? null,
      dpRadar: profile.dpRadar ?? cardBase?.dpRadar ?? null,
    } : {}),
    iidxId: cardId, iidxIdFormatted: formattedCardId,
  } : emptyCardProfile;
  const publicFallbackAllowed = Boolean(cardId && userPublicScope
    && userPublicScope.iidxId === accountScopeRef.current.iidxId
    && userPublicScope.epoch === accountScopeRef.current.epoch
    && rowsOwnerId === cardId);
  const legacyPublicFallback = publicFallbackAllowed && !(typeof cardMeta?.profileCapturedAt === 'number' && Number.isFinite(cardMeta.profileCapturedAt));
  const cardRankPublic = legacyPublicFallback ? currentUserPublic : { spRank: null, dpRank: null, dpRadar: null };
  const cardSpRank = cardProfile.spRankInt ?? cardRankPublic.spRank;
  const cardDpRank = cardProfile.dpRankInt ?? cardRankPublic.dpRank;
  const liveCardRadar = sameLive && Boolean(profile.spRadar || profile.dpRadar);
  const snapshotCardRadar = Boolean(cardMeta?.profileCapturedAt != null && (cardMeta.spRadar || cardMeta.dpRadar));
  const legacyPublicRadar = legacyPublicFallback ? currentUserPublic.dpRadar : null;
  const cardRadar = liveCardRadar
    ? { source: 'memory' as const, sp: cardProfile.spRadar, dp: cardProfile.dpRadar }
    : snapshotCardRadar
      ? { source: 'snapshot' as const, sp: cardProfile.spRadar, dp: cardProfile.dpRadar }
      : legacyPublicRadar
        ? { source: 'eagate' as const, sp: null, dp: legacyPublicRadar }
        : { source: 'snapshot' as const, sp: null, dp: null };

  // 실력값 추정 + Supabase 업로드 — tryUpload 정의 + 노출(스케줄러/콘솔/종료요청). 주기 자체는 아래 스케줄 effect.
  // tsv 재읽기는 위 실시간 reload effect(refluxState.lastTsvMtime 감지)가 담당 →
  //   여기선 그 시점 최신 rows/dp12StarResult 기준으로 업로드만 (읽기/업로드 분리).
  // 호스트 (Electron) 에서만 — PC2 (브라우저 원격) 는 중복 방지로 건너뜀.
  // 최신 profile / star / match / tsvPath 는 ref 로 추적 — 매 interval 시 최신 값 사용.
  const uploadStateRef = useRef({ profile, dp12StarResult: bundleReady ? dpTask.task.value ?? null : null,
    userRStar: bundleReady ? rTask.task.value ?? null : null,
    spStarResult: bundleReady ? spTask.task.value ?? null : null,
    acceptedBundle: acceptedStars.bundle, expectedBundle: acceptedStars.expected, bundleReady,
    dp12Match, tsvPath, spAllCharts, dpAllCharts, allTsvCharts, scope: rowsState.scope,
    tsvMtime, rowsRevision: rowsRevisionRef.current });
  uploadStateRef.current = { profile, dp12StarResult: bundleReady ? dpTask.task.value ?? null : null,
    userRStar: bundleReady ? rTask.task.value ?? null : null,
    spStarResult: bundleReady ? spTask.task.value ?? null : null,
    acceptedBundle: acceptedStars.bundle, expectedBundle: acceptedStars.expected, bundleReady,
    dp12Match, tsvPath, spAllCharts, dpAllCharts, allTsvCharts, scope: rowsState.scope,
    tsvMtime, rowsRevision: rowsRevisionRef.current };

  function uploadIdentityOk(trigger: string): { ok: true; id: string } | { ok: false; reason: string } {
    const p = uploadStateRef.current.profile;
    const snap = lastSnapshotRef.current;
    const s = sessionRef.current;
    if (trigger === 'snapshot') {
      if (s.pid != null) return { ok: false, reason: 'game-on' };
      const id = selectedViewerIdRef.current;
      if (!id || !VALID_IIDX_ID.test(id)) return { ok: false, reason: 'no-selected-account' };
      // 이 함수는 [] 의존성 effect(tryUpload)에 캡처되므로 렌더 변수 대신 ref 를 읽는다.
      if (uploadStateRef.current.scope.iidxId !== id) return { ok: false, reason: 'rows-owner-mismatch' };
      const account = accountsRef.current.find((entry) => entry.iidxId === id);
      const fallback = p.iidxId === id ? p : null;
      const resolved = resolveAccountSnapshotProfile(id, account, fallback);
      if (!resolved?.djName) return { ok: false, reason: 'no-account-meta' };
      if (rowsRef.current.length === 0) return { ok: false, reason: 'snapshot-empty' };
      return { ok: true, id };
    }
    if (!snap) return { ok: false, reason: 'no-snapshot-provenance' };
    if (!snap.iidxId || !VALID_IIDX_ID.test(snap.iidxId)) return { ok: false, reason: 'bad-provenance-id' };
    if (s.generation !== snap.generation) return { ok: false, reason: 'generation-advanced' };
    if (trigger === 'final') {
      if (!p.iidxId || p.iidxId !== snap.iidxId) return { ok: false, reason: 'final-id-mismatch' };
      return { ok: true, id: snap.iidxId };
    }
    if (s.pid == null) return { ok: false, reason: 'game-off' };
    if (!p.iidxId || !VALID_IIDX_ID.test(p.iidxId) || p.iidxId !== snap.iidxId) return { ok: false, reason: 'live-id-mismatch' };
    return { ok: true, id: snap.iidxId };
  }

  // 캡처는 동기 값 복사만 수행한다. 이후 doReset이 rows/ref를 비워도 snapshot은 변하지 않는다.
  const buildSnapshot = useCallback((reason: SnapshotReason, iidxId: string, fallbackProfile: ProfileInfo | null): UploadSnapshot | null => {
    if (!iidxId || !/^[A-Z]\d{12}$/.test(iidxId)) {
      console.log('[upload] skip reason=invalid-identity');
      return null;
    }
    const meta = accountsRef.current.find((entry) => entry.iidxId === iidxId);
    const resolvedProfile = resolveAccountSnapshotProfile(iidxId, meta, fallbackProfile);
    if (!resolvedProfile?.djName) {
      console.log('[upload] skip reason=missing-dj-name');
      return null;
    }
    const state = uploadStateRef.current;
    if (!state.bundleReady || !isUploadReady(state.acceptedBundle, state.expectedBundle)
      || state.rowsRevision !== rowsRevisionRef.current || rowsRef.current.length === 0
      || state.scope.iidxId !== iidxId || !isFloorSeedCurrent(state.scope, accountScopeRef.current)) {
      console.log('[upload] skip reason=stale-calculation-scope');
      return null;
    }
    const sameSnapshot = lastSnapshotRef.current?.iidxId === iidxId ? lastSnapshotRef.current : null;
    const snapshot: UploadSnapshot = {
      v: SNAPSHOT_VERSION,
      capturedAt: Date.now(),
      reason,
      iidxId,
      djName: resolvedProfile.djName,
      sourceIidxId: state.scope.iidxId,
      tsvMtime: sameSnapshot?.tsvMtime ?? state.tsvMtime,
      appVersion: APP_VERSION,
      profile: { ...resolvedProfile, spRadar: resolvedProfile.spRadar == null ? null : { ...resolvedProfile.spRadar }, dpRadar: resolvedProfile.dpRadar == null ? null : { ...resolvedProfile.dpRadar } },
      starResult: state.dp12StarResult,
      rStar: state.userRStar,
      charts: state.dp12Match?.charts ?? [],
      unclassifiedCharts: state.dp12Match?.unclassifiedCharts ?? [],
      spCpi: state.spStarResult?.cpiInt ?? null,
      spStar: state.spStarResult?.starRounded ?? null,
      spCharts: state.spAllCharts,
      dpAllCharts: state.dpAllCharts,
      allTsvCharts: state.allTsvCharts,
    };
    console.log(`[upload] capture reason=${reason} id=${iidxId} tsv_mtime=${snapshot.tsvMtime} charts=${snapshot.allTsvCharts.length}`);
    return snapshot;
  }, []);

  const uploadSnapshot = useCallback(async (snapshot: UploadSnapshot, trigger: string): Promise<UploadOutcome> => {
    if (IS_BROWSER_REMOTE) return { kind: 'skip-no-snapshot', reason: 'browser-remote' };
    const startedAt = Date.now();
    const savePending = window.infohsorry.upload.savePending;
    const saved = typeof savePending === 'function' ? await savePending(snapshot) : { ok: false, error: 'pending save unavailable' };
    if (!saved.ok) console.warn(`[upload] pending save failure trigger=${trigger}: ${saved.error ?? 'unknown'}`);
    try {
      const result = await uploadProfile({
        appVersion: snapshot.appVersion,
        profile: snapshot.profile as ProfileInfo,
        starResult: snapshot.starResult,
        rStar: snapshot.rStar,
        charts: snapshot.charts,
        unclassifiedCharts: snapshot.unclassifiedCharts,
        spCpi: snapshot.spCpi,
        spStar: snapshot.spStar,
        spCharts: snapshot.spCharts,
        dpAllCharts: snapshot.dpAllCharts,
        allTsvCharts: snapshot.allTsvCharts,
      });
      const durationMs = Date.now() - startedAt;
      if (!result.ok) {
        console.warn(`[upload] http failure ${result.error ?? 'unknown'} -> pending preserved`);
        addDiagLine(`업로드 실패: 서버 전송 오류(${result.error ?? '알 수 없는 오류'}) — 다음 시도에서 재전송`);
        return { kind: 'http-failure', error: result.error ?? 'upload failed', durationMs };
      }
      const clearPending = window.infohsorry.upload.clearPending;
      const cleared = typeof clearPending === 'function'
        ? await clearPending(snapshot.iidxId)
        : { ok: false, error: 'pending clear unavailable' };
      if (!cleared.ok) {
        console.warn(`[upload] success duration=${durationMs}ms but pending clear failed -> pending preserved (다음 실행에서 재전송)`);
        addDiagLine(`업로드 성공했지만 대기 기록 정리 실패(${cleared.error ?? '알 수 없는 오류'}) — 다음 시도에서 재전송`);
        return { kind: 'pending-clear-failed', error: cleared.error ?? 'pending clear failed', durationMs };
      }
      if (trigger !== 'pending') writeLastUploadAt(snapshot.iidxId, Date.now());
      console.log(`[upload] success duration=${durationMs}ms -> pending cleared`);
      return { kind: 'success', durationMs };
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      const error = (e as Error).message;
      console.warn(`[upload] http failure ${error} -> pending preserved`);
      addDiagLine(`업로드 실패: 서버 전송 오류(${error}) — 다음 시도에서 재전송`);
      return { kind: 'http-failure', error, durationMs };
    }
  }, []);

  // IIDX ID 전환은 세션(pid/generation) 전환과 별도의 축으로 감지한다.
  // Reflux 재기동 직후 tracker.tsv 는 부분적으로만 쓰일 수 있으므로, 안정화 전 스냅샷을 막는다.
  useEffect(() => {
    const refluxHooked = refluxState.stage === 'hooked' || refluxState.stage === 'ready';
    const currentId = profile.iidxId;
    if (!refluxHooked || !currentId || !VALID_IIDX_ID.test(currentId)) return;

    const previousId = lastValidIidxIdRef.current;
    const previousProfile = lastValidProfileRef.current;
    lastValidIidxIdRef.current = currentId;
    lastValidProfileRef.current = { ...profile };
    if (!previousId || previousId === currentId) return;

    void (async () => {
      const snapshot = buildSnapshot('id-switch', previousId, previousProfile);
      if (snapshot) void uploadSnapshot(snapshot, 'id-switch');

      lastLoadedMtime.current = 0;
      clearLiveSessionState();
      invalidateAccountScope(currentId, true);
      snapshotBlockUntilRef.current = Date.now() + ID_SWITCH_SNAPSHOT_BLOCK_MS;
      lastSnapshotFreshFailureRef.current = null;
      try {
        const restarted = await window.infohsorry.reflux.restart();
        if (!restarted.ok) addDiagLine(`계정 전환 후 Reflux 재시작 실패: ${restarted.error ?? '알 수 없는 오류'}`);
      } catch (e) {
        addDiagLine(`계정 전환 후 Reflux 재시작 예외: ${(e as Error).message}`);
      }
      // 재기동이 끝난 시점부터 다시 센다 — hardStop + startAll(프로세스 kill → 재기동 → 후킹) 자체가
      //   차단 시간에 육박하면 위에서 건 차단이 이미 만료돼 부분 tracker.tsv 가 통과할 수 있다.
      snapshotBlockUntilRef.current = Date.now() + ID_SWITCH_SNAPSHOT_BLOCK_MS;
      addDiagLine(`계정 전환 감지 (${previousId} → ${currentId}) — 기록 초기화 + Reflux 재시작`);
    })();
  }, [buildSnapshot, clearLiveSessionState, invalidateAccountScope, profile, refluxState.stage, uploadSnapshot]);
  useEffect(() => {
    if (liveIidxId && selectedViewerIdRef.current !== liveIidxId) void loadViewerAccount(liveIidxId);
  }, [liveIidxId, loadViewerAccount]);

  // pending은 자기 identity를 갖고 있으므로 현재 게임/프로필과 무관하게 앱 준비 후 한 번 순차 재전송한다.
  useEffect(() => {
    if (IS_BROWSER_REMOTE) return;
    let cancelled = false;
    void (async () => {
      const loadPending = window.infohsorry.upload.loadPending;
      if (typeof loadPending !== 'function') return;
      const pending = await loadPending();
      for (const snapshot of pending) {
        if (cancelled) return;
        const ageMs = Date.now() - snapshot.capturedAt;
        const outcome = await uploadSnapshot(snapshot, 'pending');
        const age = `${Math.floor(ageMs / 3_600_000)}h${Math.floor((ageMs % 3_600_000) / 60_000)}m`;
        if (outcome.kind === 'success') console.log(`[upload] retry(pending) id=${snapshot.iidxId} age=${age} -> success`);
        else console.warn(`[upload] retry(pending) id=${snapshot.iidxId} age=${age} -> ${outcome.kind}${outcome.kind === 'http-failure' ? `(${outcome.error})` : ''}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uploadSnapshot]);
  // Analysis 의 vec 재계산 + supabase upsert 트리거 — 동일 timer 가 star upload 후 증가시킴
  const [vecRecomputeKey, setVecRecomputeKey] = useState(0);

  useEffect(() => {
    if (IS_BROWSER_REMOTE) return;
    const tryUpload = async (trigger: 'auto' | 'manual' | 'initial' | 'final' | 'snapshot'): Promise<UploadOutcome> => {
      const gate = uploadIdentityOk(trigger);
      if (!gate.ok) {
        console.warn(`[upload] skip trigger=${trigger} reason=${gate.reason}`);
        if (trigger !== 'final') addDiagLine(`업로드 건너뜀: ${uploadReasonLabel(gate.reason)}`);
        return { kind: 'skip-no-snapshot', reason: gate.reason };
      }
      if (trigger !== 'final') {
        const scope = { ...accountScopeRef.current };
        const ready = await waitForBundle(() => {
          const state = uploadStateRef.current;
          const identity = uploadIdentityOk(trigger);
          if (!isFloorSeedCurrent(scope, accountScopeRef.current) || !identity.ok || identity.id !== gate.id
            || [state.acceptedBundle.dp, state.acceptedBundle.r, state.acceptedBundle.sp].some(task => task.status === 'error')) return 'invalid';
          return state.bundleReady && state.rowsRevision === rowsRevisionRef.current
            && isUploadReady(state.acceptedBundle, state.expectedBundle) ? 'ready' : 'pending';
        });
        if (!ready) return { kind: 'skip-no-snapshot', reason: 'snapshot-guard' };
      }
      if (trigger !== 'final' && trigger !== 'snapshot') {
        const fresh = await readIidxIdFresh();
        if (!fresh.ok || fresh.iidxId !== gate.id) {
          console.warn(`[upload] skip trigger=${trigger} reason=fresh-id-mismatch fresh=${fresh.ok ? fresh.iidxId : `err:${fresh.ok === false ? 'read-failed' : ''}`} gate=${gate.id}`);
          addDiagLine(`업로드 건너뜀: ${uploadReasonLabel('fresh-id-mismatch')}`);
          return { kind: 'skip-no-snapshot', reason: 'fresh-id-mismatch' };
        }
      }
      const snapshot = buildSnapshot(trigger === 'final' ? 'app-close' : trigger === 'manual' || trigger === 'snapshot' ? 'manual' : 'periodic', gate.id, uploadStateRef.current.profile);
      if (!snapshot) {
        console.warn(`[upload] skip trigger=${trigger} reason=snapshot-guard`);
        if (trigger !== 'final') addDiagLine(`업로드 건너뜀: ${uploadReasonLabel('snapshot-guard')}`);
      }
      const outcome = snapshot
        ? await uploadSnapshot(snapshot, trigger)
        : { kind: 'skip-no-snapshot' as const, reason: 'snapshot-guard' };
      if (outcome.kind === 'success') {
        const uploadedAt = Date.now();
        lastUploadAtRef.current = uploadedAt;
        setLastUploadAt(uploadedAt);
        if (trigger === 'auto') initialAutoUploadSucceededRef.current = true;
      }
      return outcome;
    };
    // 스냅샷 직후 호출 — 해당 계정의 마지막 업로드 시각이 주기를 넘었을 때만 올린다. 진행 중이면 겹치지 않는다.
    let initialTimer: number | null = null;
    let initialKey = '';
    const cancelInitialTimer = (): void => {
      if (initialTimer != null) window.clearTimeout(initialTimer);
      initialTimer = null;
      initialKey = '';
    };
    const runIfDue = (iidxId: string): void => {
      const state = uploadStateRef.current;
      const activeSession = sessionRef.current;
      const snap = lastSnapshotRef.current;
      const ready = state.bundleReady;
      const key = JSON.stringify([iidxId, state.scope.iidxId, state.scope.epoch, state.rowsRevision, state.expectedBundle, activeSession.pid, activeSession.generation]);
      if (!ready || !snap || snap.iidxId !== iidxId || snap.generation !== activeSession.generation
        || state.scope.iidxId !== iidxId || !isFloorSeedCurrent(state.scope, accountScopeRef.current)
        || selectedViewerIdRef.current !== iidxId || activeSession.pid == null) {
        cancelInitialTimer();
        if (!ready) console.log(`[upload] due id=${iidxId} 보류: 계산 준비 전`);
        return;
      }
      if (initialAutoUploadSucceededRef.current) {
        cancelInitialTimer();
        const firstSuccessAt = readLastUploadAt(iidxId);
        if (!isUploadDue(firstSuccessAt, Date.now(), AUTO_UPLOAD_MIN_GAP_MS) || autoUploadBusyRef.current) return;
        autoUploadBusyRef.current = true;
        console.log(`[upload] due id=${iidxId} last=${firstSuccessAt ? new Date(firstSuccessAt).toISOString() : 'none'}`);
        void tryUpload('auto').then((outcome) => {
          if (outcome.kind === 'success') initialAutoUploadSucceededRef.current = true;
        }).finally(() => { autoUploadBusyRef.current = false; });
        setTimeout(() => setVecRecomputeKey((k) => k + 1), 200);
        return;
      }
      if (initialTimer != null && initialKey === key) return;
      cancelInitialTimer();
      initialKey = key;
      initialTimer = window.setTimeout(() => {
        initialTimer = null;
        initialKey = '';
        const current = uploadStateRef.current;
        const currentSession = sessionRef.current;
        const currentSnapshot = lastSnapshotRef.current;
        if (JSON.stringify([iidxId, current.scope.iidxId, current.scope.epoch, current.rowsRevision, current.expectedBundle, currentSession.pid, currentSession.generation]) !== key
          || !currentSnapshot || currentSnapshot.iidxId !== iidxId || currentSnapshot.generation !== currentSession.generation
          || currentSession.pid == null || current.scope.iidxId !== iidxId
          || !isFloorSeedCurrent(current.scope, accountScopeRef.current)
          || !current.bundleReady || rowsRef.current.length === 0
          || selectedViewerIdRef.current !== iidxId || autoUploadBusyRef.current) {
          runIfDue(iidxId);
          return;
        }
        const lastAt = readLastUploadAt(iidxId);
        if (!isUploadDue(lastAt, Date.now(), AUTO_UPLOAD_MIN_GAP_MS)) return;
        const provenanceOk = (() => {
          const gate = uploadIdentityOk('auto');
          return gate.ok && gate.id === iidxId;
        })();
        if (!provenanceOk) return;
        autoUploadBusyRef.current = true;
        console.log(`[upload] initial due id=${iidxId} stable=${INITIAL_AUTO_UPLOAD_DELAY_MS}ms`);
        void tryUpload('auto').then((outcome) => {
          if (outcome.kind === 'success') initialAutoUploadSucceededRef.current = true;
        }).finally(() => { autoUploadBusyRef.current = false; });
        setTimeout(() => setVecRecomputeKey((k) => k + 1), 200);
      }, INITIAL_AUTO_UPLOAD_DELAY_MS);
    };
    const runManual = (): void => {
      if (manualUploadBusyRef.current || Date.now() - lastUploadAtRef.current < MANUAL_UPLOAD_COOLDOWN_MS) return;
      manualUploadBusyRef.current = true;
      setManualUploadBusy(true);
      void tryUpload(sessionRef.current.pid != null ? 'manual' : 'snapshot').finally(() => {
        manualUploadBusyRef.current = false;
        setManualUploadBusy(false);
      });
    };
    (window as unknown as { updateSupabase: () => void }).updateSupabase = runManual;
    (window as unknown as { __tryUploadManual?: () => void }).__tryUploadManual = runManual;
    (window as unknown as { __tryUploadIfDue?: (id: string) => void }).__tryUploadIfDue = runIfDue;
    const offFinal = window.infohsorry.upload.onFinalRequest(() => void (async () => {
      const outcome = await tryUpload('final');
      setTimeout(() => setVecRecomputeKey((k) => k + 1), 200);
      window.infohsorry.upload.finalDone(outcome);
    })());
    return () => { cancelInitialTimer(); offFinal(); delete (window as unknown as { updateSupabase?: () => void }).updateSupabase; delete (window as unknown as { __tryUploadManual?: () => void }).__tryUploadManual; delete (window as unknown as { __tryUploadIfDue?: (id: string) => void }).__tryUploadIfDue; };
  }, []);

  // 마지막 스냅샷 이후에도 준비 상태가 바뀔 수 있으므로 타이머를 직접 설정하거나 재확인한다.
  useEffect(() => {
    const id = lastSnapshotRef.current?.iidxId;
    if (id) (window as unknown as { __tryUploadIfDue?: (id: string) => void }).__tryUploadIfDue?.(id);
  }, [rows, rowsState.scope.iidxId, rowsState.scope.epoch, dp12StarResult, userRStar, spStarResult, bundleReady, acceptedStars.bundle, session.pid, session.generation]);



  // 원격모드 본인 카드 — 실시간 push. TSV 변경으로 dp12(별값/매칭)가 재계산될 때마다 /api/me 를 갱신하고,
  //   main 이 SSE me:update 를 broadcast → PC2(오소리웹 ?remote)가 보고 있는 본인 카드를 조용히 다시 그림.
  //   supabase 업로드(주기 timer, 위 effect)와 분리 — 화면 반영은 플레이 즉시, DB 부하는 주기적(15분).
  // 트리거 = "tsv 값 변동 감지" — 모든 차트의 exScore/lamp 가 하나라도 바뀌면 push (미플레이→플레이/fail/클리어 전부).
  //   profile(useProfile) 은 매 렌더 새 객체라 effect 가 매 렌더 fire 하므로, 값 시그니처로 dedup(동일 idle 재기록 skip).
  const lastRemoteSigRef = useRef('');
  const lastSetUserLogRef = useRef('');   // [임시 진단] 같은 사유 연속 로그는 1회만
  // title→textage_song_id 매핑 — 원격모드 라이벌 비교 머지 키(__textageSongId)용. 1회 로드(graceful).
  //   로드 완료 시 sig 가 바뀌어 /api/me 가 다시 push 됨(textage 키 반영).
  const [textageByTitle, setTextageByTitle] = useState<Map<string, string> | null>(null);
  useEffect(() => { getTextageByTitle().then(setTextageByTitle).catch(() => { /* graceful — 키는 song_id/title fallback */ }); }, []);
  useEffect(() => {
    // [임시 진단] setUser(/api/me) 가 어느 단계에서 멈추는지 콘솔에 1줄. 원인 확정 후 제거.
    const dbg = (msg: string): void => {
      if (lastSetUserLogRef.current === msg) return;
      lastSetUserLogRef.current = msg;
      console.log('[setUser진단]', msg);
    };
    if (IS_BROWSER_REMOTE) return dbg('skip: browser-remote');
    if (session.pid == null) return dbg('skip: game-off');
    if (!profile.iidxId || !profile.djName) return dbg(`skip: profile 없음 (id=${profile.iidxId} dj=${profile.djName})`);
    if (!/^[A-Z]\d{12}$/.test(profile.iidxId)) return dbg(`skip: iidx 형식 불일치 (${profile.iidxId})`);
    // rows 출처 ID 가드 — 업로드 가드와 동일 정책. src 미확정(null/형식불일치)이거나 불일치면 push 금지.
    //   (null && 비교로 우회되던 구멍 차단 — 옛 유저 TSV 로 만든 카드를 새 유저로 push 하지 않게.)
    const gate = uploadIdentityOk('me');
    if (!gate.ok || gate.id !== profile.iidxId)
      return dbg(`skip: provenance gate (${gate.ok ? 'id-mismatch' : gate.reason})`);
    if (!dp12StarResult || !dp12Match) return dbg(`skip: dp12 미준비 (star=${!!dp12StarResult} match=${!!dp12Match})`);
    // tsv 값 변동 감지 — 모든 차트(rated DP + unclassified DP + SP)의 exScore 합 + lamp 합.
    //   exScore 든 lamp 든 한 곳이라도 바뀌면 sig 변경 → push. (미플레이→플레이, fail, 클리어 등 전부 포함.)
    //   동일 내용의 idle 재기록(Reflux 가 ~2초마다 같은 값 다시 씀)은 sig 동일 → skip (2.6MB /api/me 폭주 방지).
    type ChartLike = { exScore?: number | null; lampNum?: number | null; lamp?: string };
    const sumEx = (arr: ChartLike[]): number =>
      arr.reduce((s, c) => s + (typeof c.exScore === 'number' ? c.exScore : 0), 0);
    const sumLamp = (arr: ChartLike[]): number =>
      arr.reduce((s, c) => s + (typeof c.lampNum === 'number' ? c.lampNum : lampNum(c.lamp ?? '')), 0);
    const part = (tag: string, arr: ChartLike[]): string =>
      tag + arr.length + ':' + sumEx(arr) + ':' + sumLamp(arr);
    const sig = [
      profile.iidxId,
      dp12StarResult.star.toFixed(3),
      part('c', dp12Match.charts),
      part('u', dp12Match.unclassifiedCharts),
      part('d', dpAllCharts),
      part('s', spAllCharts),
      spTierData ? '1' : '0',
      textageByTitle ? 't1' : 't0',   // textage 매핑 로드되면 sig 변경 → 재push(머지 키 반영)
      // 레이더/단위 — 점수와 무관하게 변할 수 있고(단위 인정 합격, 레이더 갱신), 메모리 read 가
      //   첫 push 보다 늦게 잡히는 경우도 있어 sig 에 포함. 안 넣으면 다음 점수 변동까지 카드가 빈 채로 남는다.
      `r${radarSig(profile.spRadar)}`,
      `R${radarSig(profile.dpRadar)}`,
      `k${profile.spRank ?? '-'}${profile.dpRank ?? '-'}`,
      // r★ — ratingData/lib 로드가 첫 push 보다 늦어 처음엔 null 로 나간다. sig 에 안 넣으면
      //   다음 점수 변동까지 원격 카드의 목표 폴더가 계속 비어 있다(레이더/단위와 같은 이유).
      `x${typeof userRStar === 'number' ? userRStar.toFixed(2) : '-'}`,
    ].join('|');
    if (sig === lastRemoteSigRef.current) return dbg('skip: tsv 값 변동 없음(동일)');  // 값 동일 → push 안 함
    lastRemoteSigRef.current = sig;
    dbg('PUSH ✅ setUser 호출');
    void window.infohsorry.remote.setUser(
      buildRemoteUser(profile, dp12StarResult, userRStar, dp12Match.charts, dp12Match.unclassifiedCharts, spAllCharts, spTierData, spStarResult, textageByTitle ?? undefined, dpAllCharts),
    );
  }, [profile, session.pid, dp12StarResult, userRStar, dp12Match, dpAllCharts, spAllCharts, spTierData, spStarResult, textageByTitle]);

  // 추천곡 — stage 별 reroll 카운터 (각 카드의 ↻ 버튼이 자기 stage 만 새로 뽑게).
  // 캐싱 동작:
  //   - 초기 / reroll 클릭: buildRecsWithPool 로 picked (10개 표시) + pool (보충용 남은 후보) 새로 뽑음
  //   - tracker.tsv 갱신 (= dp12Match 변경): picked 의 lamp 갱신 + 클리어된 곡 제거 + 풀에서 보충
  //   - picked 가 9개 미만으로 떨어지면 RecCard 가 "다시 받기" 버튼 표시 (재 reroll 트리거)
  type RecState = { picked: RecCandidate[]; pool: RecCandidate[] };
  const [rerollEC, setRerollEC] = useState(0);
  const [rerollHC, setRerollHC] = useState(0);
  const [rerollEXH, setRerollEXH] = useState(0);
  const [recsEC, setRecsEC] = useState<RecState>({ picked: [], pool: [] });
  const [recsHC, setRecsHC] = useState<RecState>({ picked: [], pool: [] });
  const [recsEXH, setRecsEXH] = useState<RecState>({ picked: [], pool: [] });
  const [recsWeak, setRecsWeak] = useState<RecCandidate[]>([]);
  const [rerollWeak, setRerollWeak] = useState(0);
  // Install songs as DTOs; the Worker builds the INF predicate.
  const [recSongs, setRecSongs] = useState<{ title: string; ac: number | null; legen: number | null }[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getSongsCache().then(byNorm => {
      if (!cancelled) setRecSongs(Array.from(byNorm.values()).flat().map(s => ({ title: s.title, ac: s.ac, legen: s.legen ?? null })));
    }).catch(error => console.warn('[App] recommendation songs load failed:', String(error)));
    return () => { cancelled = true; };
  }, []);
  const [recLevelMode, setRecLevelMode] = useState<RecLevelMode>('lv12');
  const handleRecLevelModeChange = (mode: RecLevelMode): void => {
    setRecLevelMode(mode);
    // mode 변경 시 EC/HC/EXH 모두 새로 뽑도록 reroll 카운터 강제 증가
    setRerollEC((k) => k + 1);
    setRerollHC((k) => k + 1);
    setRerollEXH((k) => k + 1);
  };
  // 복습곡(reached — 램프는 깼지만 DJ레벨 미달) 추천 포함 여부. 기본 'off' (제외).
  const [recDjMode, setRecDjMode] = useState<RecDjMode>('off');
  const handleRecDjModeChange = (mode: RecDjMode): void => {
    setRecDjMode(mode);
    setRerollEC((k) => k + 1);
    setRerollHC((k) => k + 1);
    setRerollEXH((k) => k + 1);
  };

  // 배치 추천 모드 — 'on' 이면 8 배치(미러/플립) 중 최적 배치 기준으로 난이도 평가, 'off' 면 정규 배치 강제.
  //   Worker query마다 배치를 명시한다. 변경 시 각 stage를 새로 뽑는다.
  const [recLayoutMode, setRecLayoutMode] = useState<'on' | 'off'>('on');
  const handleRecLayoutModeChange = (mode: 'on' | 'off'): void => {
    setRecLayoutMode(mode);
    setRerollEC((k) => k + 1);
    setRerollHC((k) => k + 1);
    setRerollEXH((k) => k + 1);
  };

  // 연습곡 (weakness) 추천 토글 state — recommend.js buildWeaknessRecs opts 와 매칭.
  const [weakMode, setWeakMode] = useState<'all' | 'CHARGE' | 'SCRATCH' | 'SOF-LAN'>('all');
  const [weakTopN, setWeakTopN] = useState<number>(10);
  const [weakHandMode, setWeakHandMode] = useState<'both' | 'left' | 'right'>('both');
  const [weakStrength, setWeakStrength] = useState<1 | 2 | 3>(1);
  // zasa ★ 범위 — null 이면 recommend.js 의 default (practiceZasaDefault: {min:11.6, max:12.7}) 사용.
  const [weakZasaMin, setWeakZasaMin] = useState<number | null>(null);
  const [weakZasaMax, setWeakZasaMax] = useState<number | null>(null);
  // 하위 레벨 patterns lazy 병합 트리거 — 추천 baseStar 가 저렙(<6)이거나 약점 zasaMin 이 11 미만일 때만
  const needLowPatterns = (ohsorryRecBase != null && ohsorryRecBase < 6) || (weakZasaMin != null && weakZasaMin < 11);
  const [expandedPatterns, setExpandedPatterns] = useState(false);
  useEffect(() => { if (needLowPatterns) setExpandedPatterns(true); }, [needLowPatterns]);
  const useLowPatterns = expandedPatterns || needLowPatterns;
  const recInput = useMemo(() => rendererInput(rowsState.scope, rowsRevisionRef.current, {
    rows, osrCharts: [], notInInf: Array.from(notInInfSet), songs: recSongs,
  }, JSON.stringify(['recommend', rowsState.scope.iidxId, rowsState.scope.epoch])),
    [rows, notInInfSet, recSongs, rowsState.scope.iidxId, rowsState.scope.epoch]);
  const recSnapshotResources = useSnapshotResources('rec-context', { rating: ratingData, zasa: zasaData, ereter: ereterData });
  const recResources = useMemo(() => recSnapshotResources && (useLowPatterns ? [
    ...recSnapshotResources,
    { key: 'patterns0810', url: `${DATA_BASE}/patterns-dp-0810.json` },
    { key: 'patternsRest', url: `${DATA_BASE}/patterns-dp-rest.json` },
  ] : recSnapshotResources), [recSnapshotResources, useLowPatterns]);
  const recCurrent = () => isFloorSeedCurrent(recInput.stamp.scope, accountScopeRef.current)
    && isFloorSeedCurrent(recInput.stamp.scope, rowsScopeRef.current)
    && selectedViewerIdRef.current === recInput.stamp.scope.iidxId
    && rowsRevisionRef.current === recInput.stamp.rowsRevision;
  const recTask = useRecommendService(recInput, recResources, rows.length > 0, recCurrent);
  const recCtx = recTask.service;
  useRecommendBridge({ service: recCtx, targetService: recTask.targets, ratingData, userRStar, baseStar: ohsorryRecBase, userCharts: dpAllCharts });
  const weakZasaDefault = recCtx?.practiceZasaDefault ?? { min: 11.6, max: 12.7 };
  const [recDisplayScope, setRecDisplayScope] = useState(rowsState.scope);
  const recDisplayCurrent = isFloorSeedCurrent(recDisplayScope, rowsState.scope) && recCurrent();
  useEffect(() => {
    setRecsEC({ picked: [], pool: [] }); setRecsHC({ picked: [], pool: [] }); setRecsEXH({ picked: [], pool: [] }); setRecsWeak([]);
    setRecDisplayScope(rowsState.scope);
    selectedClear.current.clear(); selectedPractice.current = undefined;
  }, [rowsState.scope.iidxId, rowsState.scope.epoch]);
  const selectedClear = useRef(new Map<RecStage, { scope: string; token: number; value: RecState }>());
  const recScopeKey = JSON.stringify([rowsState.scope.iidxId, rowsState.scope.epoch]);
  const clearRequests = useRef(new Map<RecStage, number>());
  const [recQueryError, setRecQueryError] = useState<string | null>(null);
  const queryToken = useMemo(() => ({}), [recCtx, rerollEC, rerollHC, rerollEXH, rerollWeak,
    ohsorryRecBase, recLevelMode, recDjMode, recLayoutMode, dp12Match,
    weakMode, weakTopN, weakHandMode, weakStrength, weakZasaMin, weakZasaMax]);
  const queryLive = useRef(queryToken);
  queryLive.current = queryToken;
  const [queryProgress, setQueryProgress] = useState<{ token: object; pending: string[] }>({ token: queryToken, pending: [] });
  const markQuery = (lane: string, pending: boolean) => {
    if (queryLive.current !== queryToken) return;
    setQueryProgress(prev => {
      const lanes = prev.token === queryToken ? prev.pending.filter(item => item !== lane) : [];
      return { token: queryToken, pending: pending ? [...lanes, lane] : lanes };
    });
  };
  const recPending = recTask.status === 'pending' || queryProgress.token !== queryToken || queryProgress.pending.length > 0;
  const updateClear = (stage: RecStage, token: number, setValue: (v: RecState) => void) => {
    if (!recCtx || ohsorryRecBase == null) return () => {};
    let cancelled = false;
    const request = (clearRequests.current.get(stage) ?? 0) + 1;
    clearRequests.current.set(stage, request);
    markQuery(stage, true);
    const prev = selectedClear.current.get(stage);
    const reroll = !prev || prev.scope !== recScopeKey || prev.token !== token;
    const options = reroll ? {
      operation: 'clear-pool', presentation: 'candidate', stage, baseStar: ohsorryRecBase, layout: recLayoutMode,
      levelMode: recLevelMode === 'lv12' ? 'lv12' : 'lv11+12', djMode: recDjMode, rerollToken: token,
    } : { operation: 'refresh', stage, previous: prev.value, charts: dp12Match?.charts ?? [], djMode: recDjMode, layout: recLayoutMode };
    void recCtx.query(options, 'ui:' + stage).then(result => {
      if (cancelled || clearRequests.current.get(stage) !== request || !recCurrent()) return;
      const value: RecState = result;
      selectedClear.current.set(stage, { scope: recScopeKey, token, value });
      setRecDisplayScope(rowsState.scope);
      setValue(value);
    }).catch(error => { if (!cancelled) setRecQueryError(String(error)); })
      .finally(() => { if (!cancelled) markQuery(stage, false); });
    return () => { cancelled = true; };
  };
  useEffect(() => { setRecQueryError(null); }, [recCtx]);
  useEffect(() => updateClear('ec', rerollEC, setRecsEC), [recCtx, rerollEC, ohsorryRecBase, recLevelMode, recDjMode, recLayoutMode, dp12Match]);
  useEffect(() => updateClear('hc', rerollHC, setRecsHC), [recCtx, rerollHC, ohsorryRecBase, recLevelMode, recDjMode, recLayoutMode, dp12Match]);
  useEffect(() => updateClear('exh', rerollEXH, setRecsEXH), [recCtx, rerollEXH, ohsorryRecBase, recLevelMode, recDjMode, recLayoutMode, dp12Match]);
  const selectedPractice = useRef<{ scope: string; key: string; rows: RecCandidate[] }>();
  useEffect(() => {
    if (!recCtx || ohsorryRecBase == null) return;
    let cancelled = false;
    const practice: Record<string, unknown> = { mode: weakMode, topN: weakTopN, handMode: weakHandMode, strength: weakStrength, flipOn: true, randomize: true };
    if (weakZasaMin != null) { practice.zasaMin = weakZasaMin; practice.minZasa = weakZasaMin; }
    if (weakZasaMax != null) { practice.zasaMax = weakZasaMax; practice.maxZasa = weakZasaMax; }
    const key = JSON.stringify([ohsorryRecBase, recLayoutMode, practice, rerollWeak]);
    const prev = selectedPractice.current;
    const reuse = prev?.scope === recScopeKey && prev.key === key;
    markQuery('weakness', true);
    void recCtx.query(reuse ? { operation: 'cards', presentation: 'candidate', layout: recLayoutMode, rows: prev.rows }
      : { operation: 'practice', presentation: 'candidate', baseStar: ohsorryRecBase, layout: recLayoutMode, practice, rerollToken: rerollWeak }, 'ui:weakness')
      .then(result => {
        if (cancelled || !recCurrent()) return;
        const value: RecCandidate[] = result;
        selectedPractice.current = { scope: recScopeKey, key, rows: value };
        setRecDisplayScope(rowsState.scope); setRecsWeak(value);
      }).catch(error => { if (!cancelled) setRecQueryError(String(error)); })
      .finally(() => { if (!cancelled) markQuery('weakness', false); });
    return () => { cancelled = true; };
  }, [recCtx, ohsorryRecBase, weakMode, weakTopN, weakHandMode, weakStrength, weakZasaMin, weakZasaMax, recLayoutMode, rerollWeak]);

  // DP12 탭 통계 — 시도 / 클리어 / HC / EXH / FC 곡 수
  const dp12Stats = useMemo(() => {
    let total = 0,
      attempted = 0,
      cleared = 0,
      hard = 0,
      exhard = 0,
      fc = 0;
    for (const c of dp12Charts) {
      if (!c.unlocked) continue;
      total++;
      if (c.lamp === 'NP') continue;
      attempted++;
      // Reflux Lamp: F < AC < EC < NC < HC < EX < FC < PFC
      if (['EC', 'NC', 'HC', 'EX', 'FC', 'PFC'].includes(c.lamp)) cleared++;
      if (['HC', 'EX', 'FC', 'PFC'].includes(c.lamp)) hard++;
      if (['EX', 'FC', 'PFC'].includes(c.lamp)) exhard++;
      if (c.lamp === 'FC' || c.lamp === 'PFC') fc++;
    }
    return { total, attempted, cleared, hard, exhard, fc };
  }, [dp12Charts]);

  const showProcessLog = rows.length === 0 && session.pid != null;
  const showRefluxLog = showProcessLog || diagLines.length > 0;

  return (
    <div className="app">
      <header className="app-header">
        <div className="title">
          <h1>
            IIDX INFINITAS DP Play Data Viewer
            <span className="by-author"> - by오소리</span>
          </h1>
        </div>
        <div className="header-right">
          <div className="actions">
            {(rows.length === 0 || !refluxState.installed) && (
              <button className="btn-primary" onClick={startReflux} disabled={busy}>
                데이터 불러오기
              </button>
            )}
          </div>
          <div className="header-cluster">
            {/* 탭이 안 보일 때 (초기 로딩) 만 헤더에 — 탭 등장하면 탭 line 으로 이동 */}
            {rows.length === 0 && <StageSpinner state={refluxState} />}
            {!IS_BROWSER_REMOTE && devMode && (
              <button
                type="button"
                className="ms-toggle"
                onClick={() => setMemoryScannerOpen(true)}
                title="프로필 스캐너 (DJ NAME / IIDX ID) — dev 모드"
                aria-label="프로필 스캐너"
              >
                🔍
              </button>
            )}
            {!IS_BROWSER_REMOTE && devMode && (() => {
              const isRunning =
                refluxState.stage !== 'idle' && refluxState.stage !== 'error';
              // 다운로드 중일 때만 비활성 — hooking(대기) / starting / hooked / ready 는 모두 끌 수 있음
              const isTransitioning = refluxState.stage === 'downloading';
              return (
                <button
                  type="button"
                  className={`reflux-toggle${isRunning ? ' on' : ''}`}
                  onClick={() => void toggleReflux()}
                  disabled={isTransitioning || busy}
                  title={isRunning ? 'Reflux 끄기' : 'Reflux 켜기'}
                  aria-label={isRunning ? 'Reflux 끄기' : 'Reflux 켜기'}
                >
                  ⏻
                </button>
              );
            })()}
            {!IS_BROWSER_REMOTE && (
              <button
                type="button"
                className="ms-toggle"
                onClick={() => setQrOpen(true)}
                title="폰/다른 PC 로 연결 (QR)"
                aria-label="폰으로 연결"
              >
                📱
              </button>
            )}
            <ThemeToggle />
          </div>
        </div>
        <WindowControls />
      </header>

      {memoryScannerOpen && <MemoryScanner onClose={() => setMemoryScannerOpen(false)} />}
      {qrOpen && <QrConnect onClose={() => setQrOpen(false)} />}

      <div className="app-body">
      {updateInfo && updateInfo.hasUpdate && updateInfo.latestVersion && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 16px',
            background: '#dcaf45',
            color: '#212529',
            fontSize: 13,
            fontWeight: 600,
            flexWrap: 'wrap',
          }}
        >
          <span>
            🆕 새 버전 <b>v{updateInfo.latestVersion}</b> 있음 (현재 v{updateInfo.currentVersion})
          </span>
          {!IS_BROWSER_REMOTE && updateDownload.stage === 'idle' && updateInfo.portableUrl && updateInfo.portableName && (
            <button
              type="button"
              onClick={async () => {
                if (!updateInfo.portableUrl || !updateInfo.portableName) return;
                setUpdateDownload({ stage: 'downloading', downloaded: 0, total: updateInfo.portableSize || 0 });
                const off = window.infohsorry.portable.onProgress((p) => {
                  setUpdateDownload((prev) => ({ ...prev, stage: 'downloading', downloaded: p.downloaded, total: p.total || prev.total }));
                });
                try {
                  const filePath = await window.infohsorry.portable.download(updateInfo.portableUrl, updateInfo.portableName);
                  setUpdateDownload({ stage: 'done', downloaded: updateInfo.portableSize || 0, total: updateInfo.portableSize || 0, filePath });
                } catch (e) {
                  setUpdateDownload({ stage: 'error', downloaded: 0, total: 0, error: (e as Error).message });
                } finally {
                  off();
                }
              }}
              style={{
                background: '#212529',
                color: '#dcaf45',
                border: 'none',
                padding: '4px 12px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                borderRadius: 4,
              }}
            >
              ⬇ 자동 다운로드 + 실행
            </button>
          )}
          {updateDownload.stage === 'downloading' && (
            <span>
              다운로드 중… {Math.round((updateDownload.downloaded / Math.max(1, updateDownload.total)) * 100)}%
              {updateDownload.total > 0 && ` (${(updateDownload.downloaded / 1024 / 1024).toFixed(1)} / ${(updateDownload.total / 1024 / 1024).toFixed(1)} MB)`}
            </span>
          )}
          {updateDownload.stage === 'done' && updateDownload.filePath && (
            <button
              type="button"
              onClick={async () => {
                const r = await window.infohsorry.portable.run(updateDownload.filePath!);
                if (!r.ok) {
                  setUpdateDownload((prev) => ({ ...prev, stage: 'error', error: r.error || '실행 실패' }));
                }
                // 성공 시 main 이 app.quit() 호출
              }}
              style={{
                background: '#212529',
                color: '#dcaf45',
                border: 'none',
                padding: '4px 12px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                borderRadius: 4,
              }}
            >
              ▶ 새 버전 실행 (현재 종료)
            </button>
          )}
          {updateDownload.stage === 'error' && (
            <span style={{ color: '#a02020' }}>
              ⚠ {updateDownload.error || '다운로드 실패'}
              {updateInfo.htmlUrl && (
                <>
                  {' — '}
                  <a href={updateInfo.htmlUrl} target="_blank" rel="noreferrer" style={{ color: '#212529', textDecoration: 'underline' }}>
                    수동 다운로드
                  </a>
                </>
              )}
            </span>
          )}
          {updateDownload.stage === 'idle' && (IS_BROWSER_REMOTE || !updateInfo.portableUrl) && updateInfo.htmlUrl && (
            <a
              href={updateInfo.htmlUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: '#212529', textDecoration: 'underline' }}
            >
              다운로드 페이지 열기 →
            </a>
          )}
          <button
            type="button"
            onClick={() => {
              if (updateInfo.latestVersion) {
                localStorage.setItem('infohsorry.update.dismissed', updateInfo.latestVersion);
              }
              setUpdateInfo(null);
            }}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: '1px solid #212529',
              color: '#212529',
              padding: '2px 8px',
              fontSize: 11,
              cursor: 'pointer',
              borderRadius: 4,
            }}
            title="이번 버전 알림 끄기"
          >
            이 버전 안 보기
          </button>
        </div>
      )}
      {showRefluxLog && (
        <RefluxLog state={refluxState} diagLines={diagLines} showProcessLines={showProcessLog} logPath={diagLogPath} />
      )}
      {rows.length === 0 && accounts.length > 0 && session.pid == null && !selectedViewerId && (
        <AccountSelector accounts={accounts} selectedId={null} liveId={liveIidxId} onSelect={(id) => void loadViewerAccount(id)} />
      )}
      {rows.length === 0 && selectedViewerId && session.pid == null && (
        <div className="empty-state"><p>저장된 기록이 없거나 불러오는 중입니다.</p></div>
      )}

      {error && !/ENOENT|no such file/i.test(error) && <div className="error">에러: {error}</div>}

      {refluxState.stage === 'idle' && rows.length === 0 && (
        <div className="empty-state">
          <p>"데이터 불러오기" 버튼을 누르면 Reflux 가 자동으로 설치 / 실행됩니다.</p>
          <p className="hint">
            첫 실행 시 Reflux.exe (~70MB) 를 GitHub 에서 다운로드합니다. 이후 캐시됩니다.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* 저장 계정 selector — 게임 ON 이면 live 계정 고정(LIVE), OFF 면 저장본 전환 */}
          {(accounts.length > 0 || liveIidxId) && (
            <AccountSelector
              accounts={accounts}
              selectedId={selectedViewerId}
              liveId={liveIidxId}
              onSelect={(id) => void loadViewerAccount(id)}
            />
          )}
          <ProfileCard
            profile={cardProfile}
            starResult={cardId != null && cardId === rowsOwnerId ? dp12StarResult : null}
            osrStar={cardId != null && cardId === rowsOwnerId ? dp12StarResult?.nativeStar ?? null : null}
            spStar={cardId != null && cardId === rowsOwnerId ? spStarResult?.star ?? null : null}
            spCpi={cardId != null && cardId === rowsOwnerId ? spStarResult?.cpiInt ?? null : null}
            spRadar={cardRadar.sp}
            dpRadar={cardRadar.dp}
            radarSource={cardRadar.source}
            spRank={cardSpRank}
            dpRank={cardDpRank}
            onStarClick={IS_BROWSER_REMOTE ? undefined : () => {
              // tsv 재로드 → rows → dp12StarResult + Analysis vec 모두 재계산. DB upload 없음.
              if (selectedViewerId) void loadViewerAccount(selectedViewerId);
            }}
          />
          <div role="status" aria-live="polite" className="hint">
            DP★ {dpTask.task.status === 'pending' ? '계산 중' : dpTask.task.status === 'error' ? '계산 실패' : dpTask.value == null ? 'N/A' : ''}
            {' · '}r★ {rTask.task.status === 'pending' ? '계산 중' : rTask.task.status === 'error' ? '계산 실패' : rTask.value == null ? 'N/A' : ''}
            {' · '}SP★ {spTask.task.status === 'pending' ? '계산 중' : spTask.task.status === 'error' ? '계산 실패' : spTask.value == null ? 'N/A' : ''}
            {[dpTask, rTask, spTask].some(task => task.task.status === 'error') && (
              <button onClick={() => {
                if (dpTask.task.status === 'error') dpTask.retry();
                if (rTask.task.status === 'error') rTask.retry();
                if (spTask.task.status === 'error') spTask.retry();
              }}>다시 계산</button>
            )}
          </div>
          <nav className="tabs">
            {/* 표시 순서: RECENT → PLAYDATA → DP RECOMMEND → ANALYSIS. 기본 탭 = PLAYDATA. */}
            <button
              className={tab === 'recent' ? 'tab active' : 'tab'}
              onClick={() => setTab('recent')}
            >
              RECENT
            </button>
            <button
              className={tab === 'playdata' ? 'tab active' : 'tab'}
              onClick={() => setTab('playdata')}
            >
              PLAYDATA
            </button>
            <button
              className={tab === 'dp12' ? 'tab active' : 'tab'}
              onClick={() => setTab('dp12')}
            >
              RECOMMEND
            </button>
            <button
              className={tab === 'grid' ? 'tab active' : 'tab'}
              onClick={() => setTab('grid')}
            >
              GRID
            </button>
            <button
              className={tab === 'analysis' ? 'tab active' : 'tab'}
              onClick={() => setTab('analysis')}
            >
              ANALYSIS
            </button>
            {/* DP / SP 탭 버튼 숨김 처리 — 로직/dispatch 분기는 유지 (다른 컴포넌트에서 setTab('dp') 호출 가능). */}
            <button
              className={tab === 'dp' ? 'tab active' : 'tab'}
              onClick={() => setTab('dp')}
              style={{ display: 'none' }}
            >
              DP
            </button>
            <button
              className={tab === 'sp' ? 'tab active' : 'tab'}
              onClick={() => setTab('sp')}
              style={{ display: 'none' }}
            >
              SP
            </button>
            <span className="tab-stats">
              {tab === 'dp12' || tab === 'grid'
                ? `${dp12Stats.total}곡 · 시도 ${dp12Stats.attempted} · 클리어 ${dp12Stats.cleared} · HC ${dp12Stats.hard} · EXH ${dp12Stats.exhard} · FC ${dp12Stats.fc}`
                : tab === 'recent' || tab === 'analysis' || tab === 'playdata'
                ? ''
                : `${rows.length}곡 · ${stats.unlocked}/${stats.total} unlock · ${stats.played} played`}
              {tsvMtime > 0 && (
                <span className="updated-at" title={new Date(tsvMtime).toLocaleString()}>
                  {' '}
                  · 갱신 {formatRelativeTime(tsvMtime)}
                </span>
              )}
              {!IS_BROWSER_REMOTE && (() => {
                const remainingMs = Math.max(0, lastUploadAt + MANUAL_UPLOAD_COOLDOWN_MS - manualUploadNow);
                const cooldownMinutes = Math.ceil(remainingMs / 60_000);
                const disabled = manualUploadBusy || remainingMs > 0 || (session.pid == null && (!selectedViewerId || rows.length === 0));
                const label = manualUploadBusy
                  ? '...'
                  : remainingMs > 0
                    ? `업로드 (${cooldownMinutes}분 뒤)`
                    : '지금 업로드';
                return (
                  <button
                    type="button"
                    className="manual-upload-btn"
                    onClick={() => (window as unknown as { __tryUploadManual?: () => void }).__tryUploadManual?.()}
                    disabled={disabled}
                  >
                    {label}
                  </button>
                );
              })()}
            </span>
            <StageSpinner state={refluxState} />
          </nav>

          <main className="content">
            {tab === 'recent' ? (
              <Recent
                rows={rows}
                iidxId={profile.iidxId}
                onPickChart={(target) => {
                  setTab('dp');
                  setScrollTarget(target);
                }}
              />
            ) : tab === 'playdata' ? (
              <PlayData
                rows={rows}
                rowsRev={rowsRevisionRef.current}
                epoch={rowsState.scope.epoch}
                accountId={rowsState.scope.iidxId}
                isWorkerCurrent={workerCurrent}
                zasaData={zasaData}
                ratingData={ratingData}
                pickTarget={playDataTarget}
                onPickConsumed={() => setPlayDataTarget(null)}
              />
            ) : tab === 'analysis' ? (
              <Analysis
                charts={analysisCharts}
                input={analysisInput}
                isCurrent={analysisCurrent}
                ratingData={ratingData}
                zasaData={zasaData}
                iidxId={profile.iidxId || undefined}
                recomputeKey={vecRecomputeKey}
                onPickChart={(title, slot) => {
                  setTab('dp');
                  setScrollTarget({ title, slot: slot as 'DPN' | 'DPH' | 'DPA' | 'DPL', gameLevel: null });
                }}
              />
            ) : tab === 'dp12' ? (
              <>
                {!IS_BROWSER_REMOTE && devMode && (
                  <StarPanel
                    result={dp12StarResult}
                    matched={dp12Match?.matched ?? 0}
                    unmatched={dp12Match?.unmatched ?? 0}
                    matchedNonNp={dp12Match?.charts.filter((c) => c.lampNum > 0).length ?? 0}
                    ereterReady={!!ereterData}
                    unmatchedSamples={dp12Match?.unmatchedSamples ?? []}
                    unmatchedAll={dp12Match?.unmatchedAll ?? []}
                    ratingUnmatchedJson={dp12Match?.ratingUnmatchedJson ?? null}
                    unclassifiedJson={unclassifiedJson}
                    ereterStatus={ereterStatus}
                    ereterBusy={ereterBusy}
                    onRefreshEreter={() => refreshEreter(true)}
                  />
                )}
                {/* 클리어 추천 — recommend.js (gist) buildRecs 호출 결과 (본체와 100% 동일 알고리즘).
                    RecRow → RecCandidate 매핑해서 기존 Recommendations / RecCard 디자인 그대로.
                    picked = 표시 10곡, pool = 클리어 시 refill 용. reroll 클릭 / 클리어 시 갱신. */}
                {rows.length > 0 && (recTask.status === 'error' || recQueryError) && (
                  <p role="alert">추천 계산 실패 <button type="button" onClick={recTask.retry}>다시 계산</button></p>
                )}
                {rows.length > 0 && ohsorryRecBase != null && recPending && <p role="status">추천 계산 중…</p>}
                {recDisplayCurrent && ohsorryRecBase != null && (recsEC.picked.length > 0 || recsHC.picked.length > 0 || recsEXH.picked.length > 0 || recsWeak.length > 0) && (
                  <Recommendations
                    recsEC={recsEC.picked}
                    recsHC={recsHC.picked}
                    recsEXH={recsEXH.picked}
                    recsWeak={recsWeak}
                    baseStar={ohsorryRecBase}
                    levelMode={recLevelMode}
                    onLevelModeChange={handleRecLevelModeChange}
                    djMode={recDjMode}
                    onDjModeChange={handleRecDjModeChange}
                    layoutMode={recLayoutMode}
                    onLayoutModeChange={handleRecLayoutModeChange}
                    onRerollEC={() => { if (recCtx) setRerollEC((k) => k + 1); }}
                    onRerollHC={() => { if (recCtx) setRerollHC((k) => k + 1); }}
                    onRerollEXH={() => { if (recCtx) setRerollEXH((k) => k + 1); }}
                    onRerollWeak={() => { if (recCtx) setRerollWeak((k) => k + 1); }}
                    recCtx={recCtx}
                    weakOpts={{
                      mode: weakMode,
                      topN: weakTopN,
                      handMode: weakHandMode,
                      strength: weakStrength,
                      zasaMin: weakZasaMin,
                      zasaMax: weakZasaMax,
                      zasaDefault: weakZasaDefault,
                    }}
                    onWeakOptsChange={(next) => {
                      setWeakMode(next.mode);
                      setWeakTopN(next.topN);
                      setWeakHandMode(next.handMode);
                      setWeakStrength(next.strength);
                      setWeakZasaMin(next.zasaMin);
                      setWeakZasaMax(next.zasaMax);
                    }}
                  />
                )}
              </>
            ) : tab === 'grid' ? (
              <>
                <h2 className="grid-title">서열표</h2>
                <p className="grid-hint">
                  zasa, ereter의 정보를 참고해서 만들었습니다.<br />
                  ★1~3 (9단), ★3~6 (10단), ★6~10 (중전)
                </p>
                <DpTable
                  lv12Charts={dp12Charts}
                  lv11Charts={dp11Charts}
                  sp12Charts={sp12Charts}
                  spTierData={spTierData}
                  ratingData={ratingData}
                  onPickChart={(target) => {
                    // DP/SP 서열표 곡 클릭 → PLAYDATA 탭 (slot 접두사로 토글/diff 자동 맞춤 + 검색창 입력)
                    setPlayDataTarget({ title: target.title, slot: target.slot });
                    setTab('playdata');
                  }}
                />
              </>
            ) : (
              <ChartTable
                rows={rows}
                style={tab}
                scrollTarget={scrollTarget}
                onScrollDone={() => setScrollTarget(null)}
              />
            )}
          </main>
        </>
      )}
      </div>
    </div>
  );
}

// ============================================================
// 추천곡 영역 (EC / HC / EXH 3 카드, 다시 뽑기)
// ============================================================
const STAGE_INFO: Record<CardStage, { prefix: string; label: string; color: string }> = {
  ec: { prefix: 'EASY', label: '클리어 추천', color: '#52a447' },
  hc: { prefix: 'HARD', label: '클리어 추천', color: '#dc3545' },
  exh: { prefix: 'EX-HARD', label: '클리어 추천', color: '#dcaf45' },
  weakness: { prefix: '', label: '연습곡 추천', color: '#ff6b9d' },
};

const DIFF_COLOR: Record<string, string> = {
  NORMAL: '#1971c2',
  HYPER: '#dcaf45',
  ANOTHER: '#dc3545',
  LEGGENDARIA: '#d678c8',
};

// 연습곡 (weakness) 카드 토글 state.
export type WeakMode = 'all' | 'CHARGE' | 'SCRATCH' | 'SOF-LAN';
export type WeakHandMode = 'both' | 'left' | 'right';
export type WeakStrength = 1 | 2 | 3;
export interface WeakOpts {
  mode: WeakMode;
  topN: number;
  handMode: WeakHandMode;
  strength: WeakStrength;
  zasaMin: number | null;       // null = 기본값 (recommend.js practiceZasaDefault.min) 사용
  zasaMax: number | null;       // null = 기본값 (recommend.js practiceZasaDefault.max) 사용
  zasaDefault: { min: number; max: number };  // 표시용 fallback
}

function Recommendations({
  recsEC,
  recsHC,
  recsEXH,
  recsWeak,
  baseStar,
  levelMode,
  onLevelModeChange,
  djMode,
  onDjModeChange,
  layoutMode,
  onLayoutModeChange,
  onRerollEC,
  onRerollHC,
  onRerollEXH,
  onRerollWeak,
  onPickChart,
  recCtx,
  weakOpts,
  onWeakOptsChange,
}: {
  recsEC: RecCandidate[];
  recsHC: RecCandidate[];
  recsEXH: RecCandidate[];
  recsWeak: RecCandidate[];
  baseStar: number;
  levelMode: RecLevelMode;
  onLevelModeChange: (mode: RecLevelMode) => void;
  djMode: RecDjMode;
  onDjModeChange: (mode: RecDjMode) => void;
  layoutMode: 'on' | 'off';
  onLayoutModeChange: (mode: 'on' | 'off') => void;
  onRerollEC: () => void;
  onRerollHC: () => void;
  onRerollEXH: () => void;
  onRerollWeak: () => void;
  onPickChart?: (r: RecCandidate) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recCtx?: any;
  weakOpts: WeakOpts;
  onWeakOptsChange: (next: WeakOpts) => void;
}): JSX.Element {
  return (
    <div className="rec-area">
      <div className="rec-area-head">
        <h3>
          추천곡 <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>★ {baseStar.toFixed(2)} 기준</span>
        </h3>
        <div className="rec-head-controls">
          <button
            type="button"
            className={`rec-review-toggle${layoutMode === 'on' ? ' active' : ''}`}
            onClick={() => onLayoutModeChange(layoutMode === 'on' ? 'off' : 'on')}
            title="배치 추천 — ON 이면 8 배치(미러/플립) 중 가장 쉬운 배치 기준으로 난이도 평가, OFF 면 정규 배치 강제"
          >
            <span className="rrt-check">{layoutMode === 'on' ? '✔︎' : '✓︎'}</span>
            <span className="rrt-label">배치 {layoutMode === 'on' ? 'ON' : 'OFF'}</span>
          </button>
          <button
            type="button"
            className={`rec-review-toggle${djMode === 'on' ? ' active' : ''}`}
            onClick={() => onDjModeChange(djMode === 'on' ? 'off' : 'on')}
            title="램프는 클리어했지만 DJ레벨이 부족한 곡(복습곡)도 추천에 포함"
          >
            <span className="rrt-check">{djMode === 'on' ? '✔︎' : '✓︎'}</span>
            <span className="rrt-label">복습곡 {djMode === 'on' ? '포함' : '제외'}</span>
          </button>
          <div className="rec-level-toggle" title="추천 풀에 포함할 게임 LEVEL 선택">
            <span className="rec-level-label">추천 범위 :</span>
            <button
              type="button"
              className={`rec-level-opt${levelMode === 'lv12' ? ' active' : ''}`}
              onClick={() => onLevelModeChange('lv12')}
              title="게임 LEVEL 12 차트만 추천"
            >
              DP12
            </button>
            <span className="rec-level-sep">|</span>
            <button
              type="button"
              className={`rec-level-opt${levelMode === 'all' ? ' active' : ''}`}
              onClick={() => onLevelModeChange('all')}
              title="게임 LEVEL 11 + 12 차트 추천"
            >
              DP11+
            </button>
          </div>
        </div>
      </div>
      <div className="rec-cards">
        <RecCard stage="ec" recs={recsEC} onReroll={onRerollEC} onPickChart={onPickChart} recCtx={recCtx} />
        <RecCard stage="hc" recs={recsHC} onReroll={onRerollHC} onPickChart={onPickChart} recCtx={recCtx} />
        <RecCard stage="exh" recs={recsEXH} onReroll={onRerollEXH} onPickChart={onPickChart} recCtx={recCtx} />
        <RecCard
          stage="weakness"
          recs={recsWeak}
          onReroll={onRerollWeak}
          onPickChart={onPickChart}
          recCtx={recCtx}
          weakOpts={weakOpts}
          onWeakOptsChange={onWeakOptsChange}
          baseStar={baseStar}
        />
      </div>
    </div>
  );
}

function RecCard({
  stage,
  recs,
  onReroll,
  onPickChart,
  recCtx,
  weakOpts,
  onWeakOptsChange,
  baseStar,
}: {
  stage: CardStage;
  recs: RecCandidate[];
  onReroll: () => void;
  onPickChart?: (r: RecCandidate) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recCtx?: any;
  weakOpts?: WeakOpts;
  onWeakOptsChange?: (next: WeakOpts) => void;
  baseStar?: number;
}): JSX.Element {
  const isWeakness = stage === 'weakness';
  // 클릭한 row 의 키 (title|slot) — 그 row 다음에 해시태그 줄 표시. 같은 row 재클릭 시 닫힘.
  const [openKey, setOpenKey] = useState<string | null>(null);
  // Worker에서 계산한 카드 DTO를 그대로 표시한다.
  const computeHashtagsFor = (r: RecCandidate): { hashtags: string; bestLabel: string } => ({
    hashtags: r.cardHashtags ?? '', bestLabel: r.cardBestLabel ?? '',
  });
  const info = STAGE_INFO[stage];
  // 모바일에서만 collapsible. uncontrolled — 초기 open 만 ref 로 설정, 이후 React 가 안 건드림.
  // (controlled 로 하면 polling re-render 가 사용자 토글을 덮어쓰는 race condition 발생)
  const [isMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  );
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (detailsRef.current) {
      detailsRef.current.open = !isMobile; // PC 펼침, 모바일 접힘
    }
  }, [isMobile]);
  return (
    <details
      ref={detailsRef}
      className={`rec-card${isWeakness ? ' rec-card-weak' : ''}`}
      style={{ borderTop: `3px solid ${info.color}` }}
    >
      <summary
        className="rec-card-head"
        onClick={isMobile ? undefined : (e) => e.preventDefault()}
      >
        <span className="rec-card-title">
          {info.prefix && <span style={{ color: info.color }}>{info.prefix}</span>}
          {info.prefix ? ' ' : ''}
          <span style={isWeakness ? { color: info.color } : undefined}>{info.label}</span>
        </span>
        <span className="rec-card-count">({recs.length}곡)</span>
        <button
          className="rec-reroll"
          disabled={!recCtx}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onReroll();
          }}
          title="랜덤 추첨 다시"
        >
          ↻
        </button>
        {isWeakness && weakOpts && onWeakOptsChange && (() => {
          // zasa★ 입력 범위 — 무조건 5.9 ~ 12.7. 그 밖은 onChange 에서 clamp.
          const CLAMP_MIN = 5.9;
          const CLAMP_MAX = 12.7;
          const clamp = (v: number): number => Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, v));
          const onZasaInput = (key: 'zasaMin' | 'zasaMax', raw: string): void => {
            if (raw === '') { onWeakOptsChange({ ...weakOpts, [key]: null }); return; }
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            onWeakOptsChange({ ...weakOpts, [key]: clamp(n) });
          };
          return (
            <span className="rec-weak-zasa-inline" onClick={(e) => e.stopPropagation()}>
              <span className="rwt-label">☆</span>
              <input
                type="number"
                className="rwt-input rwt-zasa-num"
                step={0.1}
                min={CLAMP_MIN}
                max={CLAMP_MAX}
                placeholder={weakOpts.zasaDefault.min.toFixed(1)}
                value={weakOpts.zasaMin != null ? weakOpts.zasaMin.toFixed(1) : ''}
                onChange={(e) => onZasaInput('zasaMin', e.target.value)}
                title={`연습 풀 zasa★ 최저값 (${CLAMP_MIN}~${CLAMP_MAX}, 비우면 기본 ${weakOpts.zasaDefault.min.toFixed(1)})`}
              />
              <span className="rwt-tilde">~</span>
              <input
                type="number"
                className="rwt-input rwt-zasa-num"
                step={0.1}
                min={CLAMP_MIN}
                max={CLAMP_MAX}
                placeholder={weakOpts.zasaDefault.max.toFixed(1)}
                value={weakOpts.zasaMax != null ? weakOpts.zasaMax.toFixed(1) : ''}
                onChange={(e) => onZasaInput('zasaMax', e.target.value)}
                title={`연습 풀 zasa★ 최대값 (${CLAMP_MIN}~${CLAMP_MAX}, 비우면 기본 ${weakOpts.zasaDefault.max.toFixed(1)})`}
              />
            </span>
          );
        })()}
      </summary>
      {isWeakness && weakOpts && onWeakOptsChange && (
        <div className="rec-weak-toggles" onClick={(e) => e.stopPropagation()}>
          <select
            className="rwt-pill"
            value={weakOpts.mode}
            onChange={(e) => onWeakOptsChange({ ...weakOpts, mode: e.target.value as WeakMode })}
            title="패턴 종류 — 전체 / CHARGE / SCRATCH / SOF-LAN"
          >
            <option value="all">건반</option>
            <option value="CHARGE">CHARGE</option>
            <option value="SCRATCH">SCRATCH</option>
            <option value="SOF-LAN">SOF-LAN</option>
          </select>
          <select
            className="rwt-pill"
            value={weakOpts.topN}
            onChange={(e) => onWeakOptsChange({ ...weakOpts, topN: Number(e.target.value) })}
            title="추천 곡 수"
          >
            <option value={5}>5곡</option>
            <option value={10}>10곡</option>
            <option value={15}>15곡</option>
            <option value={20}>20곡</option>
          </select>
          <select
            className="rwt-pill"
            value={weakOpts.handMode}
            onChange={(e) => onWeakOptsChange({ ...weakOpts, handMode: e.target.value as WeakHandMode })}
            title="평가할 손 — 양손 / 왼손 / 오른손"
          >
            <option value="both">양손</option>
            <option value="left">왼손</option>
            <option value="right">오른손</option>
          </select>
          <select
            className="rwt-pill"
            value={weakOpts.strength}
            onChange={(e) => onWeakOptsChange({ ...weakOpts, strength: Number(e.target.value) as WeakStrength })}
            title="강도 — 1=가볍게 / 2=중간 / 3=강하게"
          >
            <option value={1}>가볍게</option>
            <option value={2}>중간</option>
            <option value={3}>강하게</option>
          </select>
        </div>
      )}
      {recs.length === 0 ? (
        <div className="rec-empty">현재 ★값 근처의 추천곡이 없습니다.</div>
      ) : (
        <>
        <ul className="rec-list">
          {recs.map((r) => {
            const ls = lampStyle(r.currentLamp);
            // ratingMap fallback 곡 색상 구분 (ereter 미등록 곡만):
            //   lv11 → 진한 연두 (#9ccc65) / lv12 → 하늘색 (#87ceeb). ereter 매칭 곡은 기본 색.
            const titleColor = r.isRatingFallback ? (
              r.gameLevel === 11 ? '#9ccc65' :
              r.gameLevel === 12 ? '#87ceeb' : undefined
            ) : undefined;
            const titleTooltip = r.isRatingFallback ? (
              r.gameLevel === 11 ? 'ohSorry 추정 ★ (게임 LEVEL 11, ereter 미등록)' :
              r.gameLevel === 12 ? 'ohSorry 추정 ★ (게임 LEVEL 12, ereter 미등록)' : undefined
            ) : undefined;
            // 표시값 — ereter 실측 우선, 없으면 ratingMap estimates fallback
            const stageEreter = stage === 'ec' ? r.ereterEc : stage === 'hc' ? r.ereterHc : r.ereterExh;
            const displayDiff = typeof stageEreter === 'number' ? stageEreter : r.diffValue;
            const displayLevel = typeof r.ereterLevel === 'number' ? r.ereterLevel : r.level;
            const rowKey = `${r.title}|${r.slot}`;
            const isOpen = openKey === rowKey;
            // onPickChart 있으면 DP 탭 점프, 없으면 해시태그 toggle (recCtx 있을 때만).
            const clickable = !!onPickChart || !!recCtx;
            const onRowClick = (): void => {
              if (onPickChart) onPickChart(r);
              else if (recCtx) setOpenKey(isOpen ? null : rowKey);
            };
            // 배치 뱃지 — recCtx 가 있으면 항상 계산해서 ★ 왼쪽에 표시 (정규 배치면 빈 문자열).
            const rowHashInfo = computeHashtagsFor(r);
            const rowBestLabel = rowHashInfo.bestLabel;
            // 해시태그 줄 (클릭 시만) — 같은 결과 재사용.
            const tagsInfo = isOpen ? rowHashInfo : null;
            return (
              <Fragment key={rowKey}>
              <li
                className={`rec-row rec-${r.category}${clickable ? ' rec-row-clickable' : ''}`}
                onClick={clickable ? onRowClick : undefined}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(); } } : undefined}
                title={onPickChart ? '클릭 시 DP 탭에서 곡명 검색' : (recCtx ? '클릭 시 해시태그 표시' : undefined)}
              >
                <span
                  className="rec-cat"
                  title={
                    r.category === 'challenge-hard'
                      ? '하드 도전'
                      : r.category === 'challenge-easy'
                      ? '약 도전'
                      : r.category === 'exh-near'
                      ? `BP ${r.missCount ?? '?'} — 다음에 통과 후보`
                      : '정리'
                  }
                >
                  {r.category === 'exh-near' ? '⚡' : r.category === 'cleanup' ? '↓' : '↑'}
                </span>
                <span
                  className="rec-title"
                  style={titleColor ? { color: titleColor } : undefined}
                  title={titleTooltip}
                >
                  {r.unlocked === false && (
                    <span className="rec-lock" title="미해금 곡 — 아직 INFINITAS 에서 해금하지 않음">
                      🔒
                    </span>
                  )}
                  {r.title}
                </span>
                <span className="rec-diff" style={{ color: DIFF_COLOR[r.diff] || '#888' }}>
                  {r.diff[0]}
                </span>
                {rowBestLabel && (
                  <span className="rec-layout-badge" title="추천 배치">{rowBestLabel}</span>
                )}
                {isWeakness ? (
                  <span
                    className="rec-stagestar rec-stagegoal"
                    title={r.targetDjLevel ? `목표 DJ Level: ${r.targetDjLevel}` : '목표 rate'}
                  >
                    {typeof r.targetRate === 'number' ? `목표 ${r.targetRate.toFixed(1)}%` : '—'}
                  </span>
                ) : (
                  <span className="rec-stagestar">★{displayDiff.toFixed(2)}</span>
                )}
                {r.category === 'exh-near' && (
                  <span className="rec-misscount" title="미스 카운트 (BP)">
                    BP{r.missCount ?? '?'}
                  </span>
                )}
                <span className="rec-lamp" style={{ color: ls.color }}>
                  {ls.label}
                </span>
                <span className="rec-level">☆{displayLevel.toFixed(1)}</span>
              </li>
              {tagsInfo && (tagsInfo.hashtags || (isWeakness && r.currentExScore != null && r.targetExScore != null)) && (
                <li className="rec-tags-row">
                  {tagsInfo.hashtags && <span className="rec-tags-text">{tagsInfo.hashtags}</span>}
                  {isWeakness && r.currentExScore != null && r.targetExScore != null && (
                    <span className="rec-goal-text">
                      {r.currentExScore} → <b>{r.targetExScore}</b>
                      {r.targetDjLevel ? ` (${r.targetDjLevel})` : ''}
                    </span>
                  )}
                </li>
              )}
              </Fragment>
            );
          })}
        </ul>
        {recs.length < 9 && (
          <button className="rec-refill" disabled={!recCtx} onClick={onReroll}>
            ↻ 추천곡 다시 받기
          </button>
        )}
        </>
      )}
    </details>
  );
}

// ============================================================
// DP ☆12 별값 결과 패널 (ohSorry v3.2.10 모델)
// ============================================================
function StarPanel({
  result,
  matched,
  unmatched,
  matchedNonNp,
  ereterReady,
  unmatchedSamples,
  unmatchedAll,
  ratingUnmatchedJson,
  unclassifiedJson,
  ereterStatus,
  ereterBusy,
  onRefreshEreter,
}: {
  result: StarResult | null;
  matched: number;
  unmatched: number;
  matchedNonNp: number;
  ereterReady: boolean;
  unmatchedSamples: string[];
  unmatchedAll: {
    title: string;
    diff: string;
    lamp: string;
    normKey: string;
    ereterCandidates: string[];
  }[];
  ratingUnmatchedJson: {
    generatedAt: string;
    summary: { ratingPoolSize: number; tsvPoolSize: number; tsvOnlyCount: number; ratingOnlyCount: number };
    tsvOnly: { title: string; diff: string; gameLevel: number; lamp: string; normKey: string }[];
    ratingOnly: { title: string; diff: string; gameLevel: number; zasaLevel: number; normKey: string }[];
  } | null;
  unclassifiedJson: {
    generatedAt: string;
    summary: { lv12Count: number; lv11Count: number };
    lv12Unclassified: { title: string; diff: string; slot: string; gameLevel: number; lamp: string; unlocked: boolean; normKey: string }[];
    lv11Unclassified: { title: string; diff: string; slot: string; gameLevel: number; lamp: string; unlocked: boolean; normKey: string }[];
  };
  ereterStatus: EreterCacheStatus | null;
  ereterBusy: boolean;
  onRefreshEreter: () => void;
}): JSX.Element {
  if (!ereterReady) {
    return (
      <div className="star-panel waiting">
        ereter ★ 데이터 받는 중... 받아오면 별값 계산됩니다.
      </div>
    );
  }
  if (!result) {
    return (
      <div className="star-panel waiting" style={{ textAlign: 'left' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          별값 계산 대기 — onlyOSR/ereter lib 로드 또는 DP ☆12 플레이 필요
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          DP ☆12 매칭된 차트: <b>{matched}</b>개 (NP 제외: <b>{matchedNonNp}</b>개) · 미매칭 시도:{' '}
          <b>{unmatched}</b>개
          <br />
          별값은 <b>onlyOSRtoEreter.inferEreter</b> (gist lib) 로 계산됩니다 — ratingData + ereter ★ +
          DP 플레이 기록이 모두 있어야 산출됩니다.
        </div>
      </div>
    );
  }
  return (
    <div className="star-panel">
      <div className="star-main">
        <span className="star-label">DP ☆12 (ereter★)</span>
        <span className="star-value">★ {result.star.toFixed(2)}</span>
      </div>
      <div className="star-detail">
        <span>native {result.nativeStar != null ? result.nativeStar.toFixed(2) : '-'}</span>
        <span>tier {result.tier ?? '-'}</span>
        <span>nFit12 {result.nFit12 ?? '-'}</span>
        <span>매칭 {matched} / 미매칭 {unmatched}</span>
      </div>
      <details className="star-debug">
        <summary>모델 내부 (디버그)</summary>
        {unclassifiedJson && (unclassifiedJson.summary.lv12Count > 0 || unclassifiedJson.summary.lv11Count > 0) && (
          <div style={{ marginTop: 6, marginBottom: 8, padding: '6px 8px', background: 'var(--surface-2, rgba(0,0,0,0.04))', borderRadius: 4 }}>
            <div style={{ fontSize: 11.5, marginBottom: 4 }}>
              <b>서열표 미분류곡 (ereter / ratingMap / zasaData 모두 없음):</b>{' '}
              lv12 <b>{unclassifiedJson.summary.lv12Count}</b>곡 · lv11 <b>{unclassifiedJson.summary.lv11Count}</b>곡
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="dp-sort-btn"
                onClick={() => {
                  const text = JSON.stringify(unclassifiedJson, null, 2);
                  navigator.clipboard.writeText(text).then(
                    () => console.log('[unclassified-json] 클립보드 복사 완료'),
                    (e) => console.error('[unclassified-json] 클립보드 복사 실패:', e),
                  );
                }}
                title="서열표 미분류 곡 목록 JSON 을 클립보드로 복사"
              >
                JSON 복사
              </button>
              <button
                type="button"
                className="dp-sort-btn"
                onClick={() => {
                  const text = JSON.stringify(unclassifiedJson, null, 2);
                  const blob = new Blob([text], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const ts = new Date().toISOString().replace(/[:T.]/g, '-').replace('Z', '');
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `unclassified-${ts}.json`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }}
                title="서열표 미분류 곡 목록 JSON 파일 다운로드"
              >
                JSON 저장
              </button>
            </div>
          </div>
        )}
        {ratingUnmatchedJson && (
          <div style={{ marginTop: 6, marginBottom: 8, padding: '6px 8px', background: 'var(--surface-2, rgba(0,0,0,0.04))', borderRadius: 4 }}>
            <div style={{ fontSize: 11.5, marginBottom: 4 }}>
              <b>tsv ↔ ohSorryRating 미매칭:</b>{' '}
              tsv-only <b>{ratingUnmatchedJson.summary.tsvOnlyCount}</b>곡 · rating-only <b>{ratingUnmatchedJson.summary.ratingOnlyCount}</b>곡
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="dp-sort-btn"
                onClick={() => {
                  const text = JSON.stringify(ratingUnmatchedJson, null, 2);
                  navigator.clipboard.writeText(text).then(
                    () => console.log('[unmatched-json] 클립보드 복사 완료'),
                    (e) => console.error('[unmatched-json] 클립보드 복사 실패:', e),
                  );
                }}
                title="미매칭 곡 목록 JSON 을 클립보드로 복사"
              >
                JSON 복사
              </button>
              <button
                type="button"
                className="dp-sort-btn"
                onClick={() => {
                  const text = JSON.stringify(ratingUnmatchedJson, null, 2);
                  const blob = new Blob([text], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const ts = new Date().toISOString().replace(/[:T.]/g, '-').replace('Z', '');
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `rating-unmatched-${ts}.json`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                }}
                title="미매칭 곡 목록 JSON 파일 다운로드"
              >
                JSON 저장
              </button>
            </div>
          </div>
        )}
        <ul>
          <li>
            ★ {result.star.toFixed(2)} (ereter) · native{' '}
            {result.nativeStar != null ? result.nativeStar.toFixed(2) : '-'} · tier {result.tier ?? '-'} · nFit12{' '}
            {result.nFit12 ?? '-'}
          </li>
          {unmatchedAll.length > 0 && (
            <li>
              미매칭 ({unmatchedAll.length}건){' '}
              <button
                className="star-ereter-btn"
                onClick={() => {
                  // JSON 복사 — 진단 정보 포함 (ereter 후보 / 키)
                  const json = JSON.stringify(unmatchedAll, null, 2);
                  void navigator.clipboard
                    .writeText(json)
                    .then(() =>
                      alert(`미매칭 ${unmatchedAll.length}건 클립보드 복사 완료 (JSON, ereter 후보 포함)`),
                    )
                    .catch((e) => alert('복사 실패: ' + (e as Error).message));
                }}
              >
                📋 JSON 복사
              </button>{' '}
              <button
                className="star-ereter-btn"
                onClick={async () => {
                  const json = JSON.stringify(unmatchedAll, null, 2);
                  // electron 환경: saveImage 활용 어려우니 a 태그 다운로드
                  const blob = new Blob([json], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `unmatched-${new Date()
                    .toISOString()
                    .replace(/[:T.]/g, '-')
                    .replace('Z', '')}.json`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                💾 JSON 저장
              </button>
              <ul>
                {unmatchedSamples.map((s) => (
                  <li key={s} style={{ color: 'var(--text-muted)' }}>
                    {s}
                  </li>
                ))}
                {unmatchedAll.length > unmatchedSamples.length && (
                  <li style={{ color: 'var(--text-faint)', fontSize: 11 }}>
                    ... 외 {unmatchedAll.length - unmatchedSamples.length}건 (위 버튼으로 전체 받기)
                  </li>
                )}
              </ul>
            </li>
          )}
          <li>
            ereter ★ 갱신:{' '}
            {ereterStatus?.exists && ereterStatus.mtime != null
              ? formatRelativeTime(ereterStatus.mtime)
              : '데이터 없음'}
            {ereterStatus?.isStale && (
              <span className="warning"> · 24시간 경과</span>
            )}{' '}
            <button
              className="star-ereter-btn"
              onClick={onRefreshEreter}
              disabled={ereterBusy}
            >
              {ereterBusy ? '...' : '지금 갱신'}
            </button>
          </li>
        </ul>
      </details>
    </div>
  );
}

// ============================================================
// ereter ★ 데이터 캐시 상태 + 강제 갱신 버튼
// ============================================================
function EreterBar({
  status,
  busy,
  onRefresh,
}: {
  status: EreterCacheStatus | null;
  busy: boolean;
  onRefresh: () => void;
}): JSX.Element {
  let label: string;
  if (busy) {
    label = 'ereter ★ 데이터 받는 중...';
  } else if (!status || !status.exists) {
    label = 'ereter ★ 데이터 없음';
  } else if (status.mtime != null) {
    label = `ereter ★ 데이터 · 갱신 ${formatRelativeTime(status.mtime)}`;
  } else {
    label = 'ereter ★ 데이터 상태 불명';
  }
  const stale = !!status?.isStale && !busy;
  return (
    <div className={`ereter-bar${stale ? ' stale' : ''}`}>
      <span className="ereter-label">
        {label}
        {stale && status?.exists && <span className="ereter-stale-tag"> · 24시간 경과</span>}
      </span>
      <button onClick={onRefresh} disabled={busy} title="ereter.net 에서 지금 다시 받기">
        {busy ? '...' : '지금 갱신'}
      </button>
    </div>
  );
}

// ============================================================
// Reflux 의 최근 stdout/stderr 라인 표시 (접을 수 있음, 디버깅용)
// ============================================================
function RefluxLog({ state, diagLines, showProcessLines, logPath }: { state: RefluxState; diagLines: string[]; showProcessLines: boolean; logPath: string | null }): JSX.Element | null {
  const lines = showProcessLines ? (state.recentLines ?? []) : [];
  const hasProcessLines = lines.length > 0;
  const hasDiagLines = diagLines.length > 0;
  if (!hasProcessLines && !hasDiagLines) return null;
  const lastLine = hasDiagLines ? diagLines[diagLines.length - 1] : lines[lines.length - 1];
  return (
    <details className="reflux-log">
      <summary>
        Reflux 로그 — 마지막: <code>{lastLine}</code>
      </summary>
      {hasProcessLines && (
        <section>
          <h4>Reflux 프로세스</h4>
          <pre>{lines.join('\n')}</pre>
        </section>
      )}
      {hasDiagLines && (
        <section>
          <h4>계정 인식·스냅샷·뷰어</h4>
          <pre>{diagLines.join('\n')}</pre>
        </section>
      )}
      {logPath && (
        <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>{logPath}</div>
      )}
    </details>
  );
}

// ============================================================
// 단계별 진행 상태 — 데이터 불러오기 버튼 옆에 인라인 스피너 + 한 줄 텍스트
// ============================================================
function StageSpinner({ state }: { state: RefluxState }): JSX.Element | null {
  let text: string | null = null;
  switch (state.stage) {
    case 'downloading': {
      const dl = state.download;
      if (dl && dl.total > 0) {
        const mb = (dl.bytes / 1024 / 1024).toFixed(1);
        const total = (dl.total / 1024 / 1024).toFixed(1);
        text = `Reflux 다운로드 ${mb} / ${total} MB`;
      } else {
        text = 'Reflux 다운로드 중';
      }
      break;
    }
    case 'starting':
      text = 'Reflux 실행 중';
      break;
    case 'hooking':
      text = 'INFINITAS 대기 중';
      break;
    case 'hooked':
      text = '곡 선택 화면 진입 대기';
      break;
    default:
      return null;
  }
  return (
    <span className="stage-spinner">
      <span className="spinner" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}



