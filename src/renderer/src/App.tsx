import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChartSlot, EreterCacheStatus, EreterData, NotInInfChart, RatingData, RefluxState, SongRow, SpTierData, StarResult, UpdateInfo, ZasaData } from '../../shared/types';
import './api';
import { DP_SLOTS, SP_SLOTS, extractCharts } from '../../shared/types';
import { buildEreterIndex, lampNum, norm, slotToDiff } from '../../shared/match';
import { isVariantTitle } from '../../shared/variants';
import {
  compareRateDesc,
  shouldDropFromRecs,
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
import { loadRecLibs, createRecCtx, ensurePatternsLevel, loadGistModule, GIST_RAW, type RecCoreLibs } from './recommendCore';
import { ThemeToggle, WindowControls } from './theme';
import { MemoryScanner } from './MemoryScanner';
import { ProfileCard } from './ProfileCard';
import { useProfile } from './useProfile';
import { uploadProfile, fetchUserPublic, getInfChartChecker, type UserPublicInfo } from './supabaseSync';
import { buildRemoteUser } from './remoteUser';
import { IS_BROWSER_REMOTE } from './api';

// ─── 코어 recommend.js RecRow → INFOhSorry RecCandidate 매핑 ─────────────
//   buildRecsWithPool / buildWeaknessRecs 의 raw row 를 기존 Recommendations / RecCard 가 쓰는 RecCandidate 로 변환.
//   clear 추천(ec/hc/exh) + 연습곡(weakness) 공용. 모듈 레벨 — 여러 effect 에서 재사용.
const CORE_DIFF_TO_SLOT: Record<string, ChartSlot> = {
  NORMAL: 'DPN', HYPER: 'DPH', ANOTHER: 'DPA', LEGGENDARIA: 'DPL',
};
const CORE_LAMP_FULL_TO_ABBR: Record<string, string> = {
  'NO PLAY': 'NP', 'FAILED': 'F', 'ASSIST': 'AC', 'EASY': 'EC',
  'CLEAR': 'NC', 'HARD': 'HC', 'EX HARD': 'EX', 'FULL COMBO': 'FC',
};
const CORE_CAT_MAP: Record<string, RecCandidate['category']> = {
  cleanup: 'cleanup', easy: 'challenge-easy', hard: 'challenge-hard',
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recRowToCandidate(r: any, stage: CardStage): RecCandidate {
  const slot = CORE_DIFF_TO_SLOT[r.chart] || 'DPA';
  const lampFull = r.currentLamp || 'NO PLAY';
  const lampAbbr = CORE_LAMP_FULL_TO_ABBR[lampFull] || lampFull;
  const isWeak = stage === 'weakness';
  const cat: RecCandidate['category'] = isWeak ? 'cleanup' : (CORE_CAT_MAP[r._category as string] || 'cleanup');
  const countField = stage === 'weakness' ? 'ec_n' : stage + '_n';
  return {
    title: r.title, slot, diff: r.chart, level: r.level,
    currentLamp: lampAbbr,
    missCount: typeof r.missCount === 'number' ? r.missCount : null,
    ec: r.ec ?? null, hc: r.hc ?? null, exh: r.exh ?? null,
    ec_n: r.ec_n ?? null, hc_n: r.hc_n ?? null, exh_n: r.exh_n ?? null,
    diffValue: r.diffValue,
    diffCount: r[countField] ?? 0,
    margin: r.margin ?? 0,
    category: cat,
    ereterLevel: null, ereterEc: null, ereterHc: null, ereterExh: null,
    ereterEcN: null, ereterHcN: null, ereterExhN: null,
    gameLevel: r.gameLevel ?? null,
    isRatingFallback: !!r.ratingOnly,
    rate: r.scoreRate ?? null,
    exScore: r.exScore ?? null,
    noteCount: r.noteCount ?? null,
    djLevel: r.djLevel ?? null,
    lampNum: r.lampNum,
    unlocked: true,
    // weakness 전용 필드 — buildWeaknessRecs 결과의 _* 필드.
    practiceType: isWeak ? r._practiceType : undefined,
    targetRate: isWeak ? r._targetRate : undefined,
    targetExScore: isWeak ? r._targetExScore : undefined,
    currentExScore: isWeak ? r._currentExScore : undefined,
    targetDjLevel: isWeak ? r._targetDjLevel : undefined,
    // 본체 hashtag / 배치 라벨 (모든 stage 공통).
    hashtags: Array.isArray(r._hashtags) ? r._hashtags : undefined,
    bestLabel: r._matchByHand?.bestLabel || undefined,
  };
}

// 빌드 시 electron-vite 의 define 으로 package.json 의 version 자동 주입.
// 이전엔 하드코드 (0.0.12) 라 v0.0.13~v0.0.15 풀 때 supabase 업로드 버전이 옛 값으로 남음.
declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;
// 실력값 추정 + Supabase 업로드 주기 — 1분에 한 번.
// 이전엔 Reflux 의 tracker.tsv mtime 변경 (이벤트 기반) 으로만 추정 trigger 했는데,
// 계정 전환 후 Reflux 가 한참 dump 안 하면 stale 한 채로 머묾 → 분리해서 strict 1분 주기.
// 1분마다: tracker.tsv 강제 재읽기 → rows 업데이트 → dp12StarResult 자동 재계산 → upload.
// 즉시 올리고 싶으면 콘솔에서 window.updateSupabase() 수동 호출.
const STAR_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

type Tab = 'sp' | 'dp' | 'dp12' | 'analysis' | 'recent' | 'playdata' | 'grid';

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
  const [rows, setRows] = useState<SongRow[]>([]);
  const [tab, setTab] = useState<Tab>('playdata');
  // 추천곡 클릭 → DP 탭 + 해당 row 로 스크롤 타깃
  const [scrollTarget, setScrollTarget] = useState<{ title: string; slot: string; gameLevel?: number | null } | null>(null);
  // SP 서열표 곡 클릭 → PLAYDATA 탭 + 토글/diff 맞추고 검색창에 곡명 입력
  const [playDataTarget, setPlayDataTarget] = useState<{ title: string; slot: string } | null>(null);
  // 옛 ID 의 tsv 가 메모리에 남아 새 ID 로 잘못 업로드되는 사고 방지용 — 옛 IIDX ID 추적.
  // truthy → null transition (= 게임 종료 / 다른 ID 로 로그인 전 단계) 감지 시 tsv 비우기 + 로딩 데이터 reset.
  const prevIidxIdRef = useRef<string | null>(null);
  // "세션 중 한 번이라도 유효한 IIDX ID 가 잡힌 적 있는지" 추적 — false-positive 방어.
  //   INFINITAS 미실행 / 메모리 잡음으로 잠깐 truthy 가 잡혔다 사라지는 케이스에선 transit 인식 X.
  //   유효 조건: Reflux 가 hooked/ready 상태 + iidx_id 형식 매칭 (^[A-Z]\d{12}$).
  const everHadValidIidxIdRef = useRef(false);
  // null 상태 debounce timer — null 이 5초 이상 *지속* 되어야 진짜 transit 으로 판정.
  //   "데이터 불러오기" 클릭 / health-check 자동 재시작 시 stage='starting' / 'hooking' 거치는 동안
  //   useProfile 이 iidxId 를 null 로 잠깐 reset 함 → 5초 안에 ready 가 되어 다시 잡히면 cancel.
  //   INFINITAS 진짜 종료 시는 null 이 계속 유지되어 5초 후 cleanup 발동.
  const stuckNullTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 초기 supabase 업로드 1회 — 옛 ID transition 감지 시 false 로 리셋해 새 ID 정상 데이터 도착 즉시 재업로드.
  // 정의는 여기 (transition useEffect 가 참조하므로 hoisting 순서 맞춤). useEffect 본체는 아래쪽.
  const initialUploadDoneRef = useRef(false);
  // 현재 rows(TSV 점수) 가 어느 IIDX ID 의 덤프에서 온 것인지 — TSV read 성공 시 그 시점 live ID 로 태깅.
  //   업로드 직전 현재 ID 와 비교해, ID 가 바뀐 뒤 옛 rows 가 새 ID 로 잘못 올라가는 것을 차단(이중 안전장치).
  const rowsSourceIidxIdRef = useRef<string | null>(null);
  // 매 렌더마다 갱신되는 현재 live IIDX ID — profile 선언(아래쪽) 보다 위에 정의된 loadTsv / 초기 read 에서 참조용.
  const liveIidxIdRef = useRef<string | null>(null);
  const [memoryScannerOpen, setMemoryScannerOpen] = useState(false);
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
  const [tsvPath, setTsvPath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 디스크에서 마지막으로 읽은 tracker.tsv 의 mtime — 같은 mtime 으로 중복 reload 방지
  const lastLoadedMtime = useRef<number>(0);
  const [tsvMtime, setTsvMtime] = useState<number>(0);

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
  //   - 그 후 tracker.tsv 변경 시 실시간 reload effect 가 즉시 갱신 (Supabase 업로드는 3분 timer).
  //
  // 결과: 부팅 직후 잠시 빈 화면 → spawn 완료 (10~30초) 후 자동 채워짐 → 이후 tsv 변경마다 실시간 갱신.
  // (옛 동작: 마운트 즉시 옛 tsv 표시 → race condition 으로 stale 데이터 영구 노출 가능했음)
  const prevSpawnedRef = useRef(false);
  useEffect(() => {
    const off = window.infohsorry.reflux.onState((s) => {
      setRefluxState(s);
      // spawn false → true transit 감지 → readTsv 1회 자동 호출
      if (!prevSpawnedRef.current && s.spawned) {
        void (async () => {
          const path = await window.infohsorry.reflux.getTsvPath();
          const r = await window.infohsorry.readTsv(path);
          if (r.ok && r.rows && r.rows.length > 0) {
            setRows(r.rows);
            rowsSourceIidxIdRef.current = liveIidxIdRef.current;   // 이 TSV 덤프의 출처 ID 태깅
            if (r.mtime) {
              lastLoadedMtime.current = r.mtime;
              setTsvMtime(r.mtime);
            }
          }
        })();
      }
      prevSpawnedRef.current = s.spawned;
    });
    void (async () => {
      const path = await window.infohsorry.reflux.getTsvPath();
      setTsvPath(path);
      const state = await window.infohsorry.reflux.getState();
      setRefluxState(state);
      prevSpawnedRef.current = state.spawned;
      if (!state.spawned) {
        // Reflux 미spawn 상태면 자동 시작. 미설치면 startAll 안에서 자동 다운로드 + 설치 후 spawn.
        void window.infohsorry.reflux.start();
      }
    })();
    return off;
  }, []);

  // 마운트 시 ereter 상태 확인 — 24h 지났거나 데이터 없으면 자동 갱신
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
  //   "읽기는 실시간, Supabase 업로드는 3분" 분리 정책. 업로드/vec 는 아래 3분 timer 가 담당.
  //   debounce 400ms — 메모리 덤프가 짧은 간격으로 연속 갱신될 때 loadTsv 폭주 방지.
  //   (0.0.41~0.0.75 에선 race 우려로 이 이벤트 reload 를 끄고 timer 로만 읽었으나, 실시간성 위해 부활.
  //    옛 ID 잘못 업로드 사고는 loadTsv 의 rowsSourceIidxIdRef 태깅 + 업로드 가드가 별도로 막음.)
  const liveReloadRef = useRef({ loadTsv: (_p: string): Promise<void> => Promise.resolve(), tsvPath });
  const reloadDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (IS_BROWSER_REMOTE) return;                  // 원격(PC2)은 호스트가 읽어 push — 중복 방지
    const mtime = refluxState.lastTsvMtime;
    if (!mtime) return;
    const { loadTsv: lt, tsvPath: path } = liveReloadRef.current;
    if (!path) return;
    if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
    reloadDebounceRef.current = window.setTimeout(() => { void lt(path); }, 400);
    return () => {
      if (reloadDebounceRef.current) clearTimeout(reloadDebounceRef.current);
    };
  }, [refluxState.lastTsvMtime]);

  async function loadTsv(path: string): Promise<void> {
    setError(null);
    try {
      const r = await window.infohsorry.readTsv(path);
      if (!r.ok) {
        setError(r.error || '읽기 실패');
      } else {
        setRows(r.rows || []);
        rowsSourceIidxIdRef.current = liveIidxIdRef.current;   // 이 TSV 덤프의 출처 ID 태깅
        if (r.mtime) setTsvMtime(r.mtime);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // 실시간 reload effect 가 최신 loadTsv / tsvPath 를 참조하도록 매 렌더 갱신 (위 useEffect 의 dep 최소화용).
  liveReloadRef.current = { loadTsv, tsvPath };

  // "데이터 불러오기" 버튼 — Reflux 설치 + 실행 한 번에
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
  const osrChartsInput = useMemo(() => {
    if (!rows || rows.length === 0) return [];
    const out: { title: string; diff: string; lampNum: number }[] = [];
    for (const r of rows) {
      for (const slot of DP_SLOTS) {
        const cell = r.charts[slot];
        if (!cell || !cell.unlocked || !cell.lamp) continue;
        const diff = slotToDiff(slot);
        if (!diff) continue;
        out.push({ title: r.title, diff, lampNum: lampNum(cell.lamp) });
      }
    }
    return out;
  }, [rows]);

  // ── 별값(★) — v3.4.0 onlyOSRtoEreter.inferEreter (본체 calcOhsorryCore 와 동일) ──
  //   onlyOSRtoEreter 는 window.onlyOSR + window.OSR135 + window.OhsorryNorm 셋을 선행 요구
  //   (없으면 require('./xxx') 폴백 → electron renderer 에서 "require is not defined" 로 죽음).
  //   recommendCore 의 검증된 loadGistModule(= new Function eval → window 등록) 로 의존 3개를
  //   먼저 로드한 뒤 onlyOSRtoEreter 를 로드한다.
  type InferEreterFn = (
    charts: { title: string; diff: string; lampNum: number }[],
    ratingData: RatingData,
    ereterData: { charts: unknown[]; players?: Record<string, number> },
  ) => { ereterStar?: number; ohsorryStar?: number; tier?: string; nFit12?: number };
  const [onlyOSR2eLib, setOnlyOSR2eLib] = useState<{ inferEreter: InferEreterFn; version: string } | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    (async () => {
      try {
        // 선행 의존 (순서 무관, 모두 window 전역 등록). normTitle→OhsorryNorm, OSR13.5+→OSR135.
        await loadGistModule(`${GIST_RAW}/normTitle.js`, 'OhsorryNorm');
        await loadGistModule(`${GIST_RAW}/OSR13.5%2B.js`, 'OSR135');
        await loadGistModule(`${GIST_RAW}/onlyOSR.js`, 'onlyOSR');
        // onlyOSRtoEreter — 위 3개가 window 에 있으니 require 폴백 안 탐.
        const lib = (await loadGistModule(`${GIST_RAW}/onlyOSRtoEreter.js`, 'onlyOSRtoEreter')) as
          { inferEreter?: InferEreterFn; version?: string } | undefined;
        if (typeof lib?.inferEreter === 'function') {
          setOnlyOSR2eLib({ inferEreter: lib.inferEreter, version: lib.version || '?' });
          const w = window as unknown as { onlyOSR?: { version?: string } };
          console.log(`[★] onlyOSR v${w.onlyOSR?.version ?? '?'} + onlyOSRtoEreter v${lib.version ?? '?'} 로드`);
        } else {
          console.warn('[★] onlyOSRtoEreter.inferEreter 미등록 — 별값 N/A');
        }
      } catch (e) {
        console.warn('[★] 별값 lib 로드 실패:', (e as Error).message);
      }
    })();
  }, []);

  // 표시 별값(ereterStar) + 추천 native base(ohsorryStar) 를 inferEreter 한 번에 산출.
  const dp12StarResult = useMemo<StarResult | null>(() => {
    if (!onlyOSR2eLib || !ratingData || !ereterData || osrChartsInput.length === 0) return null;
    try {
      const r = onlyOSR2eLib.inferEreter(osrChartsInput, ratingData, { charts: ereterData.charts, players: {} });
      if (typeof r.ereterStar !== 'number') return null;
      const nativeStar = typeof r.ohsorryStar === 'number' ? r.ohsorryStar : r.ereterStar;
      console.log(`[★] ereterStar=${r.ereterStar.toFixed(2)} native(onlyOSR)=${nativeStar.toFixed(2)} tier=${r.tier ?? '-'} nFit12=${r.nFit12 ?? '?'}`);
      return { star: r.ereterStar, nativeStar, tier: r.tier ?? null, nFit12: r.nFit12 ?? null };
    } catch (e) {
      console.warn('[★] inferEreter 실패:', (e as Error).message);
      return null;
    }
  }, [onlyOSR2eLib, ratingData, ereterData, osrChartsInput]);

  // 추천 baseStar = 표시 별값(ereterStar) 그대로 사용.
  const ohsorryRecBase = useMemo(() => dp12StarResult?.star ?? null, [dp12StarResult]);

  // 프로필 (DJ NAME / IIDX ID / SP / DP rank) — 메모리에서 polling
  const profile = useProfile(refluxState);
  // 현재 live IIDX ID 를 ref 로 추적 — loadTsv / 초기 read 에서 "이 TSV 가 어느 ID 것인지" 태깅에 사용.
  liveIidxIdRef.current = profile.iidxId;

  // IIDX ID transition 감지 — 옛 ID 의 tsv 가 메모리에 남아 새 ID 로 잘못 업로드되는 사고 방지.
  //   (1) A → B 직접 전환: INF오소리 켜둔 채 게임만 다른 계정으로 다시 켠 경우 → 즉시 정리.
  //   (2) truthy → null: 게임 종료 / INFINITAS 죽음 → null 5초 지속 시 정리.
  // 옛 ID 의 tsv 가 메모리에 남으면 다음 interval upload 가 옛 데이터 + 새 IIDX ID 조합으로
  // 잘못 업로드 가능 → transit 시:
  //   1) tracker.tsv 내용 비우기 (truncate 0 bytes — 파일은 유지, Reflux watch 끊김 없음)
  //   2) rows / tsvMtime / lastLoadedMtime / initialUploadDoneRef 모두 reset (메모리 stale 제거)
  //
  // 가드 조건 (false-positive 방어):
  //   - 세션 중 한 번이라도 Reflux 후킹 + 유효 ID 형식 잡힌 적 있어야 함 (everHadValidIidxIdRef)
  //   - null 상태가 5초 *지속* 되어야 transit 으로 판정 (debounce) — "데이터 불러오기" 재시작 중
  //     stage='starting' / 'hooking' 거치는 동안 잠깐 null 이 되는 false-positive 회피
  // PC2 (브라우저 원격) 에선 main 측 clearTsv IPC 가 없을 수 있어 skip.
  useEffect(() => {
    const VALID = /^[A-Z]\d{12}$/;
    const prev = prevIidxIdRef.current;
    const now = profile.iidxId;
    prevIidxIdRef.current = now;
    // 유효 마킹 — Reflux 가 INFINITAS 에 후킹된 상태 + iidx_id 형식 정확히 통과한 경우만.
    const refluxHooked = refluxState.stage === 'hooked' || refluxState.stage === 'ready';
    if (refluxHooked && now && VALID.test(now)) {
      everHadValidIidxIdRef.current = true;
    }

    // 공통 정리 — 옛 ID 의 stale rows/tsv 제거 + 출처 ID 태그 reset + 재업로드 활성화.
    const doReset = (reasonMsg: string): void => {
      if (stuckNullTimerRef.current) {
        clearTimeout(stuckNullTimerRef.current);
        stuckNullTimerRef.current = null;
      }
      console.warn(`[guard] ${reasonMsg} — tsv 내용 비우기 + 로딩 데이터 reset`);
      setRows([]);
      setTsvMtime(0);
      lastLoadedMtime.current = 0;
      rowsSourceIidxIdRef.current = null;
      initialUploadDoneRef.current = false;
      if (!IS_BROWSER_REMOTE && tsvPath) {
        void (async () => {
          try {
            const r = await window.infohsorry.clearTsv(tsvPath);
            if (r.ok) {
              console.log(`[guard] tsv clear ${r.cleared ? '완료' : '(파일 없음)'}: ${tsvPath}`);
            } else {
              console.warn(`[guard] tsv clear 실패: ${r.error}`);
            }
          } catch (e) {
            console.warn(`[guard] tsv clear 예외:`, (e as Error).message);
          }
        })();
      }
    };

    // (1) A → B 직접 전환 — INF오소리는 켜둔 채 게임만 끄고 다른 계정으로 다시 켠 경우.
    //     prev/now 둘 다 유효 13자 ID 인데 서로 다르면 명백한 전환 → null 5초 debounce 없이 즉시 정리.
    //     (이게 빠지면 옛 rows + 새 ID 조합으로 잘못 업로드됨)
    if (refluxHooked && now && prev && VALID.test(now) && VALID.test(prev) && now !== prev) {
      doReset(`IIDX ID 전환 감지 (${prev} → ${now})`);
      return;
    }

    // ID 가 다시 잡힘 → pending null debounce 취소
    if (now) {
      if (stuckNullTimerRef.current) {
        clearTimeout(stuckNullTimerRef.current);
        stuckNullTimerRef.current = null;
      }
      return;
    }
    // (2) truthy → null transition — 게임 종료 / INFINITAS 죽음.
    if (!prev) return;                          // 직전 tick 도 null — 그냥 idle
    if (!everHadValidIidxIdRef.current) return; // 한 번도 유효 ID 잡힌 적 없음 — false-positive
    // null 이 5초 *지속* 되어야 진짜 transit 으로 판정 (재시작 중 잠깐 null 되는 false-positive 회피).
    // 이미 timer 가 돌고 있으면 그대로 둠.
    if (stuckNullTimerRef.current) return;
    stuckNullTimerRef.current = setTimeout(() => {
      doReset(`IIDX ID 5초 이상 끊김 (이전: ${prev})`);
    }, 5000);
  }, [profile.iidxId, refluxState.stage, tsvPath]);

  // 유저 공개 정보 (DP 노트레이더 + SP/DP 단위) — supabase 에서 iidxId 감지 시 1회 fetch.
  // 메모리 리딩이 단위를 못 가져오는 케이스가 있어 supabase 저장값 (getInfRadar.js 가 eagate djdata 에서 채움) 으로 보강.
  // 데이터 없는 필드는 ProfileCard 가 영역 자체 숨김.
  const [userPublic, setUserPublic] = useState<UserPublicInfo>({ dpRadar: null, spRank: null, dpRank: null });
  useEffect(() => {
    if (!profile.iidxId || !/^[A-Z]\d{12}$/.test(profile.iidxId)) {
      setUserPublic({ dpRadar: null, spRank: null, dpRank: null });
      return;
    }
    let cancelled = false;
    fetchUserPublic(profile.iidxId).then((r) => {
      if (!cancelled) setUserPublic(r);
    });
    return () => { cancelled = true; };
  }, [profile.iidxId]);

  // 실력값 추정 + Supabase 업로드 — 3분 주기 (STAR_REFRESH_INTERVAL_MS).
  // tsv 재읽기는 위 실시간 reload effect(refluxState.lastTsvMtime 감지)가 담당 →
  //   여기선 그 시점 최신 rows/dp12StarResult 기준으로 업로드만 (읽기/업로드 분리).
  // 호스트 (Electron) 에서만 — PC2 (브라우저 원격) 는 중복 방지로 건너뜀.
  // 최신 profile / star / match / tsvPath 는 ref 로 추적 — 매 interval 시 최신 값 사용.
  const uploadStateRef = useRef({ profile, dp12StarResult, dp12Match, tsvPath, spAllCharts, allTsvCharts });
  uploadStateRef.current = { profile, dp12StarResult, dp12Match, tsvPath, spAllCharts, allTsvCharts };
  // Analysis 의 vec 재계산 + supabase upsert 트리거 — 동일 timer 가 star upload 후 증가시킴
  const [vecRecomputeKey, setVecRecomputeKey] = useState(0);

  useEffect(() => {
    if (IS_BROWSER_REMOTE) return;

    const tryUpload = (trigger: 'auto' | 'manual' | 'initial'): void => {
      const { profile: p, dp12StarResult: s, dp12Match: m, spAllCharts: spAll, allTsvCharts: allTsv } = uploadStateRef.current;
      const tag = `[supabase:${trigger}]`;
      if (!p.iidxId || !p.djName) {
        console.log(`${tag} skip: 프로필 미로드`, { iidxId: p.iidxId, djName: p.djName });
        return;
      }
      if (!/^[A-Z]\d{12}$/.test(p.iidxId)) {
        console.log(`${tag} skip: IIDX ID 형식 불일치 —`, p.iidxId);
        return;
      }
      // 이중 안전장치 — 현재 rows 가 다른 ID 의 덤프에서 온 것이면 업로드 건너뜀(새 TSV 덤프 대기).
      //   ID 전환 직후 가드 cleanup 과 비동기 upload 가 경쟁하는 상황까지 방어.
      const src = rowsSourceIidxIdRef.current;
      if (src && src !== p.iidxId) {
        console.warn(`${tag} skip: rows 출처 ID(${src}) ≠ 현재 ID(${p.iidxId}) — 새 TSV 덤프 대기`);
        return;
      }
      if (!s) {
        console.log(`${tag} skip: ★ 추정 결과 없음`);
        return;
      }
      if (!m) {
        console.log(`${tag} skip: dp12Match 없음`);
        return;
      }
      console.log(`${tag} 업로드 시작 → iidxId:`, p.iidxId, 'star:', s.star.toFixed(2));
      // (원격모드 본인 카드 setUser 는 아래 별도 effect 가 dp12 재계산 즉시 실시간 push — 3분 supabase 업로드와 분리.)
      void uploadProfile({
        appVersion: APP_VERSION,
        profile: p,
        starResult: s,
        charts: m.charts,
        // 서열표 '미분류' 곡 — charts_json 에만 합쳐 올림 (lamp 통계는 m.charts 만 집계)
        unclassifiedCharts: m.unclassifiedCharts,
        spCharts: spAll,   // SP 차트 — 업로더가 gameLevel 10~12 만 play_style:0 으로 적재
        allTsvCharts: allTsv,   // TSV 전곡 — songs 마스터 곡 등록(플레이 무관)용
      }).then((r) => {
        if (r.ok) console.log(`${tag} 업로드 성공`);
        else console.warn(`${tag} upsert 실패:`, r.error);
      });
    };

    // 콘솔 수동 호출 — updateSupabase()
    (window as unknown as { updateSupabase: () => void }).updateSupabase = (): void =>
      tryUpload('manual');

    // 3분마다: Supabase star upload → 200ms 뒤 vec 재계산 + upsert.
    //   tsv 재읽기는 위 실시간 reload effect(refluxState.lastTsvMtime 감지)가 담당 — 읽기/업로드 분리.
    const interval = window.setInterval(() => {
      tryUpload('auto');
      setTimeout(() => setVecRecomputeKey((k) => k + 1), 200);
    }, STAR_REFRESH_INTERVAL_MS);
    console.log(`[supabase] 실력값 추정 + 업로드 + pattern vec 활성화 — ${STAR_REFRESH_INTERVAL_MS / 1000}초 간격, 수동: updateSupabase()`);

    // 노출 — 새 useEffect 에서 초기 업로드 트리거할 수 있도록
    (window as unknown as { __tryUploadInitial?: () => void }).__tryUploadInitial = (): void =>
      tryUpload('initial');

    return (): void => {
      window.clearInterval(interval);
      delete (window as unknown as { updateSupabase?: () => void }).updateSupabase;
      delete (window as unknown as { __tryUploadInitial?: () => void }).__tryUploadInitial;
    };
  }, []);

  // 초기 한 번만 — profile / star / match 모두 준비됨 감지하면 즉시 supabase 업로드
  // (auto 3분 interval 첫 트리거를 기다리지 않고 데이터 로딩 끝나는 즉시 한 번)
  // (initialUploadDoneRef 선언은 위쪽 — 옛 ID transition cleanup useEffect 가 먼저 참조.)
  useEffect(() => {
    if (IS_BROWSER_REMOTE) return;
    if (initialUploadDoneRef.current) return;
    if (!profile.iidxId || !profile.djName) return;
    if (!/^[A-Z]\d{12}$/.test(profile.iidxId)) return;
    if (!dp12StarResult) return;
    if (!dp12Match) return;
    initialUploadDoneRef.current = true;
    const fn = (window as unknown as { __tryUploadInitial?: () => void }).__tryUploadInitial;
    if (fn) fn();
  }, [profile, dp12StarResult, dp12Match]);

  // 원격모드 본인 카드 — 실시간 push. TSV 변경으로 dp12(별값/매칭)가 재계산될 때마다 /api/me 를 갱신하고,
  //   main 이 SSE me:update 를 broadcast → PC2(오소리웹 ?remote)가 보고 있는 본인 카드를 조용히 다시 그림.
  //   supabase 업로드(3분 주기, 위 effect)와 분리 — 화면 반영은 플레이 즉시, DB 부하는 그대로 3분.
  // profile(useProfile) 은 매 렌더 새 객체라 effect 가 매 렌더 fire → 내용 안 바뀌어도 setUser 폭주 →
  //   SSE me:update 폭주 → 오소리웹 카드가 계속 재렌더되던 문제. 내용 시그니처로 dedup, 바뀔 때만 push.
  const lastRemoteSigRef = useRef('');
  const lastSetUserLogRef = useRef('');   // [임시 진단] 같은 사유 연속 로그는 1회만
  useEffect(() => {
    // [임시 진단] setUser(/api/me) 가 어느 단계에서 멈추는지 콘솔에 1줄. 원인 확정 후 제거.
    const dbg = (msg: string): void => {
      if (lastSetUserLogRef.current === msg) return;
      lastSetUserLogRef.current = msg;
      console.log('[setUser진단]', msg);
    };
    if (IS_BROWSER_REMOTE) return dbg('skip: browser-remote');
    if (!profile.iidxId || !profile.djName) return dbg(`skip: profile 없음 (id=${profile.iidxId} dj=${profile.djName})`);
    if (!/^[A-Z]\d{12}$/.test(profile.iidxId)) return dbg(`skip: iidx 형식 불일치 (${profile.iidxId})`);
    // rows 출처 ID 가드 — ID 전환 직후 옛 덤프로 만든 카드를 올리지 않게 (업로드 가드와 동일 정책).
    if (rowsSourceIidxIdRef.current && rowsSourceIidxIdRef.current !== profile.iidxId)
      return dbg(`skip: 출처ID 불일치 (rows=${rowsSourceIidxIdRef.current} != profile=${profile.iidxId})`);
    if (!dp12StarResult || !dp12Match) return dbg(`skip: dp12 미준비 (star=${!!dp12StarResult} match=${!!dp12Match})`);
    const sumEx = (arr: { exScore?: number | null }[]): number =>
      arr.reduce((s, c) => s + (typeof c.exScore === 'number' ? c.exScore : 0), 0);
    const sig = [
      profile.iidxId,
      dp12StarResult.star.toFixed(3),
      dp12Match.charts.length + ':' + sumEx(dp12Match.charts),
      dp12Match.unclassifiedCharts.length,
      spAllCharts.length + ':' + sumEx(spAllCharts),
      spTierData ? '1' : '0',
    ].join('|');
    if (sig === lastRemoteSigRef.current) return dbg('skip: sig 동일(중복)');  // 내용 동일 → push 안 함
    lastRemoteSigRef.current = sig;
    dbg('PUSH ✅ setUser 호출');
    void window.infohsorry.remote.setUser(
      buildRemoteUser(profile, dp12StarResult, dp12Match.charts, dp12Match.unclassifiedCharts, spAllCharts, spTierData),
    );
  }, [profile, dp12StarResult, dp12Match, spAllCharts, spTierData]);

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
  // recommend.js (gist) lib 로드 — RecCard 의 row 클릭 시 해시태그 / 배치 라벨 표시용.
  //   마운트 1회만 fetch. ctx 는 rows / rating / zasa / ereter 변경 시 재생성.
  //   ctx 활용해서 추천곡 별 chartStrengthMatchByHand + computeRecHashtags 결과를 Map 으로.
  const [recLibs, setRecLibs] = useState<RecCoreLibs | null>(null);
  // patterns 하위 구간(0810/rest) lazy 병합이 끝날 때마다 +1 → recCtx 재생성 트리거.
  //   ensurePatternsLevel 이 recLibs.patterns 를 in-place 병합하므로 ctx 만 다시 돌리면 병합분 반영.
  const [patBandsReady, setPatBandsReady] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const libs = await loadRecLibs();
        if (!cancelled) setRecLibs(libs);
      } catch (e) {
        console.warn('[App] recommend lib 로드 실패 (해시태그 비활성):', (e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  // INF 수록 차트 판정기 (supabase songs.ac/legen 기반) — 연습곡 풀이 AC 전용 차트를 거르는 데 사용.
  //   마운트 1회 로드 (songs 캐시 fetch). 실패 시 null → notInINF 만으로 필터.
  const [infChecker, setInfChecker] = useState<((title: string, chartName?: string) => boolean) | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const checker = await getInfChartChecker();
        if (!cancelled) setInfChecker(() => checker);
      } catch (e) {
        console.warn('[App] INF 차트 판정기 로드 실패 (notInINF 만 적용):', (e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  // 코어 buildWeaknessRecs 에 넘길 INF 필터 — notInINF(수동 제외) 우선 + songs 기반 INF 수록 판정.
  //   chartName(DP_NOR/HYP/ANO/LEG) → slot(DPN/DPH/DPA/DPL) 매핑해 notInInfSet 매칭.
  const isInfChart = useMemo(() => {
    const CN_TO_SLOT: Record<string, string> = { DP_NOR: 'DPN', DP_HYP: 'DPH', DP_ANO: 'DPA', DP_LEG: 'DPL' };
    return (title: string, chartName?: string): boolean => {
      const slot = chartName ? CN_TO_SLOT[chartName] : undefined;
      if (slot && notInInfSet.has(norm(title) + '|' + slot)) return false;  // 수동 제외 우선
      return infChecker ? infChecker(title, chartName) : true;             // songs 기반 (로딩 전엔 통과)
    };
  }, [infChecker, notInInfSet]);
  // ctx — 데이터 변경 시 재생성 (lib 가 ready 일 때만).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recCtx = useMemo<any>(() => {
    if (!recLibs) return null;
    if (rows.length === 0) return null;
    try {
      return createRecCtx({ libs: recLibs, rows, ratingData, zasaData, ereterData, isInfChart });
    } catch (e) {
      console.warn('[App] recCtx 생성 실패:', (e as Error).message);
      return null;
    }
  }, [recLibs, rows, ratingData, zasaData, ereterData, isInfChart, patBandsReady]);

  const lastRerollEC = useRef(-1);
  const lastRerollHC = useRef(-1);
  const lastRerollEXH = useRef(-1);

  function refreshRecs(
    prev: RecState,
    stage: RecStage,
    charts: RecInputChart[],
    djMode: RecDjMode,
  ): RecState {
    const map = new Map<string, RecInputChart>();
    for (const c of charts) map.set(c.title + '|' + c.slot, c);
    // 갱신 정책 (ohSorry v3.3.5 reached 모델):
    //   - 제거: shouldDropFromRecs — 더 강한 lamp 까지 진입했거나 reached + DJ Level 통과
    //   - 갱신: lamp / missCount / djLevel / exScore / noteCount 변화 시 새 객체 (EXH 면 rate 재계산)
    //   - 변화 없으면 같은 ref 재사용 → React 재렌더 skip
    const updateCandidate = (r: RecCandidate, c: RecInputChart): RecCandidate | null => {
      const changed =
        c.lamp !== r.currentLamp ||
        c.missCount !== r.missCount ||
        c.djLevel !== r.djLevel ||
        c.exScore !== r.exScore ||
        c.noteCount !== r.noteCount ||
        c.lampNum !== r.lampNum;
      if (!changed) return null;
      const rate =
        stage === 'exh' && typeof c.exScore === 'number' && typeof c.noteCount === 'number' && c.noteCount > 0
          ? c.exScore / (c.noteCount * 2)
          : stage === 'exh'
          ? null
          : r.rate;
      return {
        ...r,
        currentLamp: c.lamp,
        missCount: c.missCount,
        djLevel: c.djLevel,
        exScore: c.exScore ?? null,
        noteCount: c.noteCount ?? null,
        lampNum: c.lampNum,
        rate,
      };
    };

    let droppedCount = 0;
    let pickedChanged = false;
    const updatedPicked: RecCandidate[] = [];
    for (const r of prev.picked) {
      const c = map.get(r.title + '|' + r.slot);
      if (c) {
        if (shouldDropFromRecs(stage, c.lampNum, c.djLevel, djMode)) {
          droppedCount++;
          pickedChanged = true;
          continue;
        }
        const next = updateCandidate(r, c);
        if (next) {
          updatedPicked.push(next);
          pickedChanged = true;
        } else {
          updatedPicked.push(r);
        }
      } else {
        updatedPicked.push(r);
      }
    }
    let poolChanged = false;
    const updatedPool: RecCandidate[] = [];
    for (const r of prev.pool) {
      const c = map.get(r.title + '|' + r.slot);
      if (c) {
        if (shouldDropFromRecs(stage, c.lampNum, c.djLevel, djMode)) {
          poolChanged = true;
          continue;
        }
        const next = updateCandidate(r, c);
        if (next) {
          updatedPool.push(next);
          poolChanged = true;
        } else {
          updatedPool.push(r);
        }
      } else {
        updatedPool.push(r);
      }
    }
    // 제거된 만큼 풀에서 보충
    while (droppedCount > 0 && updatedPool.length > 0) {
      const next = updatedPool.shift();
      if (next) updatedPicked.push(next);
      droppedCount--;
      poolChanged = true;
    }
    if (!pickedChanged && !poolChanged) return prev;
    // 변화 있을 때만 정렬:
    //   EC/HC — diffValue (★) asc
    //   EXH   — rate desc (null 뒤로) — buildExhRecs 와 동일한 순서 유지
    if (stage === 'exh') {
      updatedPicked.sort((a, b) => compareRateDesc(a.rate, b.rate));
    } else {
      updatedPicked.sort((a, b) => a.diffValue - b.diffValue);
    }
    return { picked: updatedPicked, pool: updatedPool };
  }

  // v3.3.5: 추천 baseStar — dp12StarResult.star (D2 표기 ★) 대신 ohsorryRecBase (OSR 단독) 사용
  // recLevelMode — ohSorry 원본은 baseStar≥6 시 'lv12' (lv11 차트 제외). INF DP12 컨텍스트에선 거의 항상 lv12.
  // 사용자가 토글로 'all' (DP11+) 로 바꿀 수도 있어서 state 로 관리.
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
  //   recCtx.setLayoutMode 로 코어에 전달. 변경 시 EC/HC/EXH 새로 뽑고, weak useEffect 는 deps 로 재계산.
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
  //   0810 / rest 구간을 받아 recLibs.patterns 에 병합 (ohSorryWeb users.js 와 동일 조건). 평소(11·12)엔 미발생.
  useEffect(() => {
    if (!recLibs) return;
    const needLow = (ohsorryRecBase != null && ohsorryRecBase < 6) || (weakZasaMin != null && weakZasaMin < 11);
    if (!needLow) return;
    let cancelled = false;
    void (async () => {
      await ensurePatternsLevel(recLibs, '0810');
      await ensurePatternsLevel(recLibs, 'rest');
      if (!cancelled) setPatBandsReady((n) => n + 1);
    })();
    return () => { cancelled = true; };
  }, [recLibs, ohsorryRecBase, weakZasaMin]);
  // recCtx 의 practiceZasaDefault 를 표시용 fallback 으로 노출. ctx 없으면 안전 default.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const weakZasaDefault: { min: number; max: number } = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (recCtx as any)?.practiceZasaDefault;
    if (d && typeof d.min === 'number' && typeof d.max === 'number') return d;
    return { min: 11.6, max: 12.7 };
  }, [recCtx]);

  // 코어 recommend.js 의 buildRecsWithPool 호출 → { picked, pool } (RecCandidate 매핑).
  //   randomize:true — 후보 30풀에서 계층 랜덤 추출 (리롤마다 변동). pool 은 클리어 시 refreshRecs refill 용.
  const coreRecsWithPool = useCallback(
    (stage: RecStage, threshold: number): RecState => {
      if (!recCtx || ohsorryRecBase == null) return { picked: [], pool: [] };
      if ((stage === 'hc' || stage === 'exh') && ohsorryRecBase < 0.5) return { picked: [], pool: [] };
      const lvMode = recLevelMode === 'lv12' ? 'lv12' : 'lv11+12';
      const djModeStr = recDjMode === 'on' ? 'on' : 'off';
      try {
        if (typeof recCtx.setLayoutMode === 'function') recCtx.setLayoutMode(recLayoutMode);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = recCtx.buildRecsWithPool(threshold, stage, ohsorryRecBase, lvMode, djModeStr, { randomize: true });
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          picked: (res?.picked || []).map((r: any) => recRowToCandidate(r, stage)),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: (res?.pool || []).map((r: any) => recRowToCandidate(r, stage)),
        };
      } catch (e) {
        console.warn('[App] buildRecsWithPool 실패:', (e as Error).message);
        return { picked: [], pool: [] };
      }
    },
    [recCtx, ohsorryRecBase, recLevelMode, recDjMode, recLayoutMode],
  );

  // 연습곡 (weakness) — buildWeaknessRecs(randomize) 결과를 state 로. 리롤(rerollWeak)/옵션 변경 시 60풀에서 재추출.
  //   recCtx 식별자 대신 recCtxReady(boolean) 의존 → 데이터 polling re-render 마다 reshuffle 되는 것 방지.
  const recCtxReady = recCtx != null;
  useEffect(() => {
    if (!recCtx || ohsorryRecBase == null) { setRecsWeak([]); return; }
    try {
      if (typeof recCtx.setLayoutMode === 'function') recCtx.setLayoutMode(recLayoutMode);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = { mode: weakMode, topN: weakTopN, handMode: weakHandMode, strength: weakStrength, flipOn: true, randomize: true };
      if (weakZasaMin != null) { opts.zasaMin = weakZasaMin; opts.minZasa = weakZasaMin; }
      if (weakZasaMax != null) { opts.zasaMax = weakZasaMax; opts.maxZasa = weakZasaMax; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const weak: any[] = recCtx.buildWeaknessRecs(ohsorryRecBase, opts);
      setRecsWeak(weak.map((r) => recRowToCandidate(r, 'weakness')));
    } catch (e) {
      console.warn('[App] buildWeaknessRecs 실패:', (e as Error).message);
      setRecsWeak([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recCtxReady, ohsorryRecBase, weakMode, weakTopN, weakHandMode, weakStrength, weakZasaMin, weakZasaMax, recLayoutMode, rerollWeak]);

  // 클리어 추천 (EC/HC/EXH) — reroll 클릭 시 코어 풀에서 새로 추출, 그 외(데이터 갱신) 는 refreshRecs 로 drop+refill.
  useEffect(() => {
    if (!recCtx || ohsorryRecBase == null) return;
    if (lastRerollEC.current !== rerollEC) {
      lastRerollEC.current = rerollEC;
      setRecsEC(coreRecsWithPool('ec', 3));
    } else if (dp12Match) {
      setRecsEC((prev) => refreshRecs(prev, 'ec', dp12Match.charts, recDjMode));
    }
  }, [rerollEC, recCtx, ohsorryRecBase, recLevelMode, recDjMode, dp12Match, coreRecsWithPool]);
  useEffect(() => {
    if (!recCtx || ohsorryRecBase == null) return;
    if (lastRerollHC.current !== rerollHC) {
      lastRerollHC.current = rerollHC;
      setRecsHC(coreRecsWithPool('hc', 5));
    } else if (dp12Match) {
      setRecsHC((prev) => refreshRecs(prev, 'hc', dp12Match.charts, recDjMode));
    }
  }, [rerollHC, recCtx, ohsorryRecBase, recLevelMode, recDjMode, dp12Match, coreRecsWithPool]);
  useEffect(() => {
    if (!recCtx || ohsorryRecBase == null) return;
    if (lastRerollEXH.current !== rerollEXH) {
      lastRerollEXH.current = rerollEXH;
      setRecsEXH(coreRecsWithPool('exh', 6));
    } else if (dp12Match) {
      setRecsEXH((prev) => refreshRecs(prev, 'exh', dp12Match.charts, recDjMode));
    }
  }, [rerollEXH, recCtx, ohsorryRecBase, recLevelMode, recDjMode, dp12Match, coreRecsWithPool]);

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
            <ThemeToggle />
          </div>
        </div>
        <WindowControls />
      </header>

      {memoryScannerOpen && <MemoryScanner onClose={() => setMemoryScannerOpen(false)} />}

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
      {rows.length === 0 && <RefluxLog state={refluxState} />}

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
          <ProfileCard
            profile={profile}
            starResult={dp12StarResult}
            osrStar={dp12StarResult?.nativeStar ?? null}
            dpRadar={userPublic.dpRadar}
            spRank={userPublic.spRank}
            dpRank={userPublic.dpRank}
            onStarClick={IS_BROWSER_REMOTE ? undefined : () => {
              // tsv 재로드 → rows → dp12StarResult + Analysis vec 모두 재계산. DB upload 없음.
              if (tsvPath) void loadTsv(tsvPath);
            }}
          />
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
                zasaData={zasaData}
                ratingData={ratingData}
                pickTarget={playDataTarget}
                onPickConsumed={() => setPlayDataTarget(null)}
              />
            ) : tab === 'analysis' ? (
              <Analysis
                charts={[...dp12Charts, ...dp11Charts]}
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
                {ohsorryRecBase != null && (recsEC.picked.length > 0 || recsHC.picked.length > 0 || recsEXH.picked.length > 0 || recsWeak.length > 0) && (
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
                    onRerollEC={() => setRerollEC((k) => k + 1)}
                    onRerollHC={() => setRerollHC((k) => k + 1)}
                    onRerollEXH={() => setRerollEXH((k) => k + 1)}
                    onRerollWeak={() => setRerollWeak((k) => k + 1)}
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
  // recommend.js 의 chartStrengthMatchByHand + computeRecHashtags 호출 — recCtx 가 있고 openKey 있을 때만.
  //   본체 패턴 (ohsorryRender.js 의 __dp_rec_tags_row) 과 동일 결과.
  const CAT_MAP: Record<string, string> = {
    'challenge-hard': 'hard', 'challenge-easy': 'easy', 'cleanup': 'cleanup', 'exh-near': 'cleanup',
  };
  const computeHashtagsFor = (r: RecCandidate): { hashtags: string; bestLabel: string } => {
    if (!recCtx) return { hashtags: '', bestLabel: '' };
    try {
      const rRow = { title: r.title, chart: r.diff, _category: CAT_MAP[r.category] || 'cleanup' };
      const matchByHand = recCtx.chartStrengthMatchByHand(rRow);
      const tags = recCtx.computeChartTags(rRow);
      const fullR = { ...rRow, _matchByHand: matchByHand, _tags: tags };
      const hashtags = recCtx.computeRecHashtags(fullR);
      return {
        hashtags: Array.isArray(hashtags) ? hashtags.join(' ') : '',
        bestLabel: (matchByHand?.bestLabel as string) || '',
      };
    } catch {
      return { hashtags: '', bestLabel: '' };
    }
  };
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
            const rowHashInfo = recCtx ? computeHashtagsFor(r) : { hashtags: '', bestLabel: '' };
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
          <button className="rec-refill" onClick={onReroll}>
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
function RefluxLog({ state }: { state: RefluxState }): JSX.Element | null {
  const lines = state.recentLines;
  if (!lines || lines.length === 0) return null;
  return (
    <details className="reflux-log">
      <summary>
        Reflux 로그 (최근 {lines.length}줄) — 마지막: <code>{lines[lines.length - 1]}</code>
      </summary>
      <pre>{lines.join('\n')}</pre>
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
