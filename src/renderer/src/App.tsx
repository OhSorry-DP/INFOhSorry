import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChartSlot, EreterCacheStatus, EreterData, RatingData, RefluxState, SongRow, UpdateInfo, ZasaData } from '../../shared/types';
import './api';
import { DP_SLOTS, extractCharts } from '../../shared/types';
import { buildEreterIndex, lampNum, norm, slotToDiff } from '../../shared/match';
import { estimateStar, type FitDatum, type PoolChart } from '../../shared/star-estimator';
import { inferUserTiered as osrInferUserTieredBundle, version as osrBundleVersion } from '../../shared/calc-osrating';
import { adoptStar as adoptStarBundle, version as adoptBundleVersion, type AdoptInput, type AdoptOutput } from '../../shared/adopt';
import {
  buildExhRecs,
  buildRecsWithPool,
  compareRateDesc,
  shouldDropFromRecs,
  type RecCandidate,
  type RecInputChart,
  type RecLevelMode,
  type RecStage,
} from '../../shared/recommend';
import { lampStyle, letterColor } from './lampStyle';
import ChartTable from './ChartTable';
import DpTable from './DpTable';
import { ThemeToggle, WindowControls } from './theme';
import { MemoryScanner } from './MemoryScanner';
import { ProfileCard } from './ProfileCard';
import { useProfile } from './useProfile';
import { uploadProfile } from './supabaseSync';
import { IS_BROWSER_REMOTE } from './api';

// 빌드 시 electron-vite 의 define 으로 package.json 의 version 자동 주입.
// 이전엔 하드코드 (0.0.12) 라 v0.0.13~v0.0.15 풀 때 supabase 업로드 버전이 옛 값으로 남음.
declare const __APP_VERSION__: string;
const APP_VERSION = __APP_VERSION__;
// 실력값 추정 + Supabase 업로드 주기 — 1분에 한 번.
// 이전엔 Reflux 의 tracker.tsv mtime 변경 (이벤트 기반) 으로만 추정 trigger 했는데,
// 계정 전환 후 Reflux 가 한참 dump 안 하면 stale 한 채로 머묾 → 분리해서 strict 1분 주기.
// 1분마다: tracker.tsv 강제 재읽기 → rows 업데이트 → dp12StarResult 자동 재계산 → upload.
// 즉시 올리고 싶으면 콘솔에서 window.updateSupabase() 수동 호출.
const STAR_REFRESH_INTERVAL_MS = 60 * 1000;

type Tab = 'sp' | 'dp' | 'dp12';

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
  const [tab, setTab] = useState<Tab>('dp');
  // 추천곡 클릭 → DP 탭 + 해당 row 로 스크롤 타깃
  const [scrollTarget, setScrollTarget] = useState<{ title: string; slot: string; gameLevel?: number | null } | null>(null);
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

  // ohSorryRating — ereter 미등록 lv11/lv12 차트 추정값 (추천 풀 fallback)
  // 우선순위: ereter > rating. ereter 매칭 곡은 절대 rating 으로 덮지 않음.
  const [ratingData, setRatingData] = useState<RatingData | null>(null);

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

  // 마운트 시: Reflux state 구독 + tsvPath / 현재 state 가져오기 + tracker.tsv 자동 복원
  // Reflux 가 설치돼있으면 무조건 자동 시작 (5분 health check 가 떴는지 계속 확인).
  // 미설치면 "데이터 불러오기" 버튼으로 사용자가 직접 install 트리거.
  // browser 모드 (LAN) 에서는 window.infohsorry 가 HTTP bridge 로 자동 patch (api.ts).
  useEffect(() => {
    const off = window.infohsorry.reflux.onState((s) => setRefluxState(s));
    void (async () => {
      const path = await window.infohsorry.reflux.getTsvPath();
      setTsvPath(path);
      const state = await window.infohsorry.reflux.getState();
      setRefluxState(state);
      // tsv 읽기 — RefluxManager 가 cleanup 을 process lifetime 의 첫 spawn 1회만 수행하므로
      //   재부팅 시 (spawned=false) 이전 세션 tracker.tsv 가 보존됨 → 일단 읽어서 화면에 띄우고,
      //   그 다음 spawn 으로 INFINITAS 메모리에서 새 tsv dump 시작.
      //   첫 설치 / 첫 부팅이면 readTsv 가 빈 결과 (파일 없음) — 그냥 0 rows 로 통과, start() 가 진행.
      const r = await window.infohsorry.readTsv(path);
      if (r.ok && r.rows && r.rows.length > 0) {
        setRows(r.rows);
        if (r.mtime) {
          lastLoadedMtime.current = r.mtime;
          setTsvMtime(r.mtime);
        }
      }
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

  // 마운트 시 GitHub 최신 릴리즈 체크 (5초 지연 후 — 초기 로딩 우선).
  // 실패 / 네트워크 끊김 / 같은 버전이면 배너 안 뜸.
  useEffect(() => {
    const t = setTimeout(() => {
      void (async () => {
        try {
          const info = await window.infohsorry.update.check();
          if (info.hasUpdate && info.latestVersion) {
            const dismissed = localStorage.getItem('infohsorry.update.dismissed');
            if (dismissed !== info.latestVersion) {
              setUpdateInfo(info);
            }
          }
        } catch {
          /* ignore */
        }
      })();
    }, 5000);
    return () => clearTimeout(t);
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

  // (이전: Reflux 의 lastTsvMtime 변화 감지 → 자동 reload. 제거됨.)
  // 실력값 추정 + tsv 재읽기는 별도 1분 timer 로만 trigger (Reflux 이벤트 안 받음).

  async function loadTsv(path: string): Promise<void> {
    setError(null);
    try {
      const r = await window.infohsorry.readTsv(path);
      if (!r.ok) {
        setError(r.error || '읽기 실패');
      } else {
        setRows(r.rows || []);
        if (r.mtime) setTsvMtime(r.mtime);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

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
    if (tab === 'dp12') return { total: 0, unlocked: 0, played: 0 };
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

  // DP ☆12 차트 추출 — 서열표 input
  // 매칭 우선순위: ereter ★ → ohSorryRating (gameLevel===12) zasaLevel (둘 다 없으면 미분류).
  // ratingMap 만 매칭된 차트는 추천 / ★값 추정엔 사용 X — 격자 분류만 영향.
  const dp12Charts = useMemo(() => {
    const charts = extractCharts(rows, { slots: DP_SLOTS, level: 12 });
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
  }, [rows, ereterData, ratingData, zasaData]);

  // DP ☆11 차트 추출 — ohSorryRating.ratings (gameLevel === 11) 의 zasaLevel 매칭
  //   ereter 는 ★12 만 등재 → lv11 격자는 ohSorryRating 의 zasaLevel 로 그룹화
  const dp11Charts = useMemo(() => {
    const charts = extractCharts(rows, { slots: DP_SLOTS, level: 11 });
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
  }, [rows, ratingData, zasaData]);

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
    if (zasaData) {
      for (const z of zasaData.charts) {
        zasaIdx.set(norm(z.title) + '|' + z.diff, z.level);
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
        if (c.level !== 11 && c.level !== 12) continue;
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
      ratingKeyset.add(normKey);
      const hit = tsvIdx.get(normKey);
      if (!hit) {
        ratingMissCount++;
        ratingMissedInTsv.push({ title: rt.title, diff: rt.diff, gameLevel: rt.gameLevel, zasaLevel: rt.zasaLevel, normKey });
        continue;
      }
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
        zasaLevel: zasaIdx.get(key) ?? null,
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
  }, [rows, ereterData, ratingData, zasaData]);

  // 별값 추정 input — dp12Match 에서 derive
  // v3.3.3: 4종 fitData scope 동시 수집 (ohSorry 와 동일).
  // 새 구조 (2026-05-14): chart.level/ec/hc/exh 는 ratingMap estimates,
  //   ereter 실측은 chart.ereterLevel/Ec/Hc/Exh 별도 필드. fitData 빌더는 ereter 우선 + estimates fallback.
  //
  //   - fitDataEreterOnly: ereter 매칭 곡만, ereter 실측 EC/HC/EXH
  //   - fitDataLv12Only:   ereter (lv12 자동) + ratingMap gameLevel===12, 우선 ereter 실측
  //   - fitDataAll:        전체, ereter 우선 + estimates fallback
  const dp12StarInputs = useMemo(() => {
    if (!dp12Match) return null;
    const fitDataEreterOnly: FitDatum[] = [];
    const fitDataLv12Only: FitDatum[] = [];
    const fitDataAll: FitDatum[] = [];
    const poolCharts: PoolChart[] = [];
    for (const c of dp12Match.charts) {
      // poolCharts (features pool: acfcPool / v32Cleared) 는 ereter-matched 만 (ohSorry 와 동일).
      const isEreter = !c.isRatingFallback;
      if (isEreter) {
        poolCharts.push({
          lampNum: c.lampNum,
          level: c.ereterLevel ?? c.level,
          djLevel: c.djLevel,
          ec: c.ereterEc,
          hc: c.ereterHc,
          exh: c.ereterExh,
        });
      }
      // 별값 추정 input 은 zasa★ 11.6~12.7 만 (chart.level = zasaLevel).
      if (c.lampNum > 0 && c.level >= 11.6 && c.level <= 12.7) {
        // 값 선택: ereter 실측 우선, 없으면 ratingMap estimates
        const ec = isEreter && typeof c.ereterEc === 'number' ? c.ereterEc : c.ec;
        const hc = isEreter && typeof c.ereterHc === 'number' ? c.ereterHc : c.hc;
        const exh = isEreter && typeof c.ereterExh === 'number' ? c.ereterExh : c.exh;
        const items: FitDatum[] = [];
        if (typeof ec === 'number') items.push({ d: ec, p: c.lampNum >= 3 ? 1 : 0, stage: 'ec' });
        if (typeof hc === 'number') items.push({ d: hc, p: c.lampNum >= 5 ? 1 : 0, stage: 'hc' });
        if (typeof exh === 'number') items.push({ d: exh, p: c.lampNum >= 6 ? 1 : 0, stage: 'exh' });
        const isLv12 = isEreter || c.gameLevel === 12;
        fitDataAll.push(...items);
        if (isLv12) fitDataLv12Only.push(...items);
        if (isEreter) {
          // fitDataEreterOnly 는 ereter 실측만 (estimates fallback X)
          const ereterItems: FitDatum[] = [];
          if (typeof c.ereterEc === 'number') ereterItems.push({ d: c.ereterEc, p: c.lampNum >= 3 ? 1 : 0, stage: 'ec' });
          if (typeof c.ereterHc === 'number') ereterItems.push({ d: c.ereterHc, p: c.lampNum >= 5 ? 1 : 0, stage: 'hc' });
          if (typeof c.ereterExh === 'number') ereterItems.push({ d: c.ereterExh, p: c.lampNum >= 6 ? 1 : 0, stage: 'exh' });
          fitDataEreterOnly.push(...ereterItems);
        }
      }
    }
    // useOnlyLv12 분기 — LEVEL 12 (이레터 + lv12 rating) 플레이 ≥ 30
    const nLv12Played = dp12Match.charts.filter(
      (c) => (!c.isRatingFallback || c.gameLevel === 12) && c.lampNum > 0,
    ).length;
    const useOnlyLv12 = nLv12Played >= 30;
    return {
      fitDataEreterOnly,
      fitDataLv12Only,
      fitDataAll,
      poolCharts,
      useOnlyLv12,
      nLv12Played,
    };
  }, [dp12Match]);

  // v3.3.3: 4번 호출 (primary + 3 secondary) → max 채택, 2nd 도 별도 보관.
  // primary 는 useOnlyLv12 분기 결과지만 어차피 max 로 다시 정해지므로 사실상 식별용 라벨.
  const dp12StarAll = useMemo(() => {
    if (!dp12StarInputs) return null;
    const primaryFit = dp12StarInputs.useOnlyLv12
      ? dp12StarInputs.fitDataLv12Only
      : dp12StarInputs.fitDataAll;
    return [
      { name: 'primary' as const, res: estimateStar(primaryFit, dp12StarInputs.poolCharts) },
      {
        name: 'ereter-only' as const,
        res: estimateStar(dp12StarInputs.fitDataEreterOnly, dp12StarInputs.poolCharts),
      },
      {
        name: 'lv12-only' as const,
        res: estimateStar(dp12StarInputs.fitDataLv12Only, dp12StarInputs.poolCharts),
      },
      {
        name: 'all-11.6+' as const,
        res: estimateStar(dp12StarInputs.fitDataAll, dp12StarInputs.poolCharts),
      },
    ];
  }, [dp12StarInputs]);

  // max-of-4 채택 — 저렙 fallback (★0.01) 자동 보완. dp12StarOldResult 는 v3.3.3 의 max 결과.
  const dp12StarOldResult = useMemo(() => {
    if (!dp12StarAll) return null;
    const valid = dp12StarAll.filter((x) => x.res != null);
    if (valid.length === 0) return null;
    valid.sort((a, b) => (b.res!.star ?? 0) - (a.res!.star ?? 0));
    return valid[0].res;
  }, [dp12StarAll]);

  // ohSorry v3.3.4: osr (v0.0.2) inferUserTiered 추가 → ensemble 평균
  //   charts 변환 — SongRow / DP_SLOTS → { title, diff, lampNum } 단순 형식
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

  // gist 자동 갱신된 lib (cache) 가 더 최신이면 그것 우선 사용. 없거나 옛 버전이면 bundle 사용.
  // startup 시 main 에 IPC 요청 → eval → osrLibOverride 에 저장. 이후 inferUserTiered 호출에 사용.
  const [osrLibOverride, setOsrLibOverride] = useState<{ inferUserTiered: typeof osrInferUserTieredBundle; version: string } | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.infohsorry?.osrLib) return;
    window.infohsorry.osrLib.get().then((cached) => {
      if (!cached || !cached.code || !cached.version) return;
      // version 비교: cache > bundle 일 때만 override
      const a = cached.version.split('.').map((n) => parseInt(n, 10) || 0);
      const b = osrBundleVersion.split('.').map((n) => parseInt(n, 10) || 0);
      let newer = false;
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] || 0) > (b[i] || 0)) { newer = true; break; }
        if ((a[i] || 0) < (b[i] || 0)) break;
      }
      if (!newer) {
        console.log(`[osr] bundle (v${osrBundleVersion}) 사용 (cache v${cached.version} 동일 또는 옛 버전)`);
        return;
      }
      try {
        // UMD wrapper 의 IIFE 실행 — window.ohSorryRating 에 등록됨
        new Function(cached.code)();
        const w = window as unknown as { ohSorryRating?: { inferUserTiered?: typeof osrInferUserTieredBundle } };
        if (typeof w.ohSorryRating?.inferUserTiered === 'function') {
          setOsrLibOverride({ inferUserTiered: w.ohSorryRating.inferUserTiered, version: cached.version });
          console.log(`[osr] gist cache v${cached.version} 사용 (bundle v${osrBundleVersion})`);
        }
      } catch (e) {
        console.warn('[osr] cache eval 실패:', (e as Error).message);
      }
    });
  }, []);

  const osrTieredResult = useMemo<{ star: number; group?: string; nativeStar?: number; bandCorrection?: number; nEnriched?: number; nLv12Cleared?: number; nZ12_0upCleared?: number } | null>(() => {
    if (!ratingData || osrChartsInput.length === 0) return null;
    const inferFn = osrLibOverride?.inferUserTiered || osrInferUserTieredBundle;
    try {
      const r = inferFn(osrChartsInput, ratingData) as {
        ereterCompatStar?: number;
        nativeStar?: number;
        group?: string;
        bandCorrection?: number;
        nEnriched?: number;
        nLv12Cleared?: number;
        nZ12_0upCleared?: number;
      };
      // v3.3.5 진단: 입력 chart 수 + 매칭 chart 수 + group 분기 결과
      console.log(
        `[osr] charts.in=${osrChartsInput.length} nEnriched=${r.nEnriched ?? '?'} ` +
        `nLv12cl=${r.nLv12Cleared ?? '?'} nZ12cl=${r.nZ12_0upCleared ?? '?'} ` +
        `group=${r.group ?? '-'} native=${r.nativeStar?.toFixed(2) ?? '?'} ` +
        `compat=${r.ereterCompatStar?.toFixed(2) ?? '?'} (corr=${r.bandCorrection ?? 0})`
      );
      return typeof r.ereterCompatStar === 'number'
        ? { star: r.ereterCompatStar, group: r.group, nativeStar: r.nativeStar, bandCorrection: r.bandCorrection, nEnriched: r.nEnriched, nLv12Cleared: r.nLv12Cleared, nZ12_0upCleared: r.nZ12_0upCleared }
        : null;
    } catch (e) {
      console.warn('[osr] inferUserTiered 실패:', (e as Error).message);
      return null;
    }
  }, [osrChartsInput, ratingData, osrLibOverride]);

  // v3.3.5: OSR13.5+ lib (gist auto-update + cache eval) — window.OSR135 등록
  const [osr135Lib, setOsr135Lib] = useState<{ inferUser: (charts: unknown, ereter: unknown) => { starEstimate: number; adopted: string }; version: string } | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.infohsorry?.osrLib135) return;
    window.infohsorry.osrLib135.get().then((cached) => {
      if (!cached || !cached.code) return;
      try {
        new Function(cached.code)();
        const w = window as unknown as { OSR135?: { inferUser?: (c: unknown, e: unknown) => { starEstimate: number; adopted: string }; version?: string } };
        if (typeof w.OSR135?.inferUser === 'function') {
          setOsr135Lib({ inferUser: w.OSR135.inferUser, version: w.OSR135.version || cached.version || '?' });
          console.log(`[osr135] gist cache v${cached.version} 로드`);
        }
      } catch (e) {
        console.warn('[osr135] cache eval 실패:', (e as Error).message);
      }
    });
  }, []);

  // OSR13.5+ 결과 계산 — ereterData.charts 필요. ec/hc/exh 도 spread gate 용으로 보존.
  const osr135Result = useMemo<{ star: number; adopted: string; ec: number; hc: number; exh: number } | null>(() => {
    if (!osr135Lib || !ereterData || osrChartsInput.length === 0) return null;
    try {
      // any cast — OSR135 의 inferUser 가 ec/hc/exh 도 반환 (lib 정의에 명시 안 돼 있어서)
      const r = osr135Lib.inferUser(osrChartsInput, { charts: ereterData.charts }) as
        { starEstimate?: number; adopted: string; ec?: { final: number }; hc?: { final: number }; exh?: { final: number } };
      return typeof r.starEstimate === 'number'
        ? { star: r.starEstimate, adopted: r.adopted, ec: r.ec?.final ?? 0, hc: r.hc?.final ?? 0, exh: r.exh?.final ?? 0 }
        : null;
    } catch (e) {
      console.warn('[osr135] inferUser 실패:', (e as Error).message);
      return null;
    }
  }, [osr135Lib, ereterData, osrChartsInput]);

  // oldOSR (v3.3.3 4-scope inference) — gist auto-update + cache eval — window.oldOSR 등록
  // INF오소리의 자체 dp12StarOldResult 가 ohSorry/recompute 와 알고리즘이 미세하게 달라 ★ 값이 어긋나서
  // gist oldOSR.js 를 INF오소리도 fetch 해서 동일 결과를 쓰도록 통일.
  const [oldOSRLib, setOldOSRLib] = useState<{ inferUser: (charts: unknown, rating: unknown, ereter: unknown) => unknown; version: string } | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.infohsorry?.oldOSRLib) return;
    window.infohsorry.oldOSRLib.get().then((cached) => {
      if (!cached || !cached.code) return;
      try {
        new Function(cached.code)();
        const w = window as unknown as { oldOSR?: { inferUser?: (c: unknown, r: unknown, e: unknown) => unknown; version?: string } };
        if (typeof w.oldOSR?.inferUser === 'function') {
          setOldOSRLib({ inferUser: w.oldOSR.inferUser, version: w.oldOSR.version || cached.version || '?' });
          console.log(`[oldOSR] gist cache v${cached.version} 로드`);
        }
      } catch (e) {
        console.warn('[oldOSR] cache eval 실패:', (e as Error).message);
      }
    });
  }, []);

  // oldOSR 결과 계산 — ratingData + ereterData.charts 필요. starEstimates 의 ereterOnly/lv12Only 는 group C 2-scope max 용.
  const oldOSRResult = useMemo<{
    starEstimate: number | null;
    ereterOnly: number | null;
    lv12Only: number | null;
    adopted: string | null;
  } | null>(() => {
    if (!oldOSRLib || !ratingData || !ereterData || osrChartsInput.length === 0) return null;
    try {
      const r = oldOSRLib.inferUser(osrChartsInput, ratingData, { charts: ereterData.charts }) as {
        starEstimate: number | null;
        starEstimates?: { primary?: number | null; ereterOnly?: number | null; lv12Only?: number | null; all?: number | null };
        adopted?: string | null;
      };
      return {
        starEstimate: typeof r.starEstimate === 'number' ? r.starEstimate : null,
        ereterOnly: typeof r.starEstimates?.ereterOnly === 'number' ? r.starEstimates.ereterOnly : null,
        lv12Only: typeof r.starEstimates?.lv12Only === 'number' ? r.starEstimates.lv12Only : null,
        adopted: r.adopted ?? null,
      };
    } catch (e) {
      console.warn('[oldOSR] inferUser 실패:', (e as Error).message);
      return null;
    }
  }, [oldOSRLib, ratingData, ereterData, osrChartsInput]);

  // adopt.js (v335E 채택 분기 통합 lib) — bundle + override 패턴 (osr.js 와 동일)
  //   기본: bundle (src/shared/adopt.ts) 사용 → 첫 부팅 / 오프라인에서도 작동
  //   override: gist cache 가 더 최신이면 cache 사용 → 분기 로직 갱신 즉시 반영
  // 세 lib (oldOSR/OSR/OSR135) raw 값을 받아 최종 ★ 결정. ohSorry/recompute/INFOhSorry 3곳 동일 lib 호출.
  const [adoptLibOverride, setAdoptLibOverride] = useState<{ adoptStar: (input: AdoptInput) => AdoptOutput; version: string } | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.infohsorry?.adoptLib) return;
    window.infohsorry.adoptLib.get().then((cached) => {
      if (!cached || !cached.code || !cached.version) return;
      // version 비교: cache > bundle 일 때만 override
      const a = cached.version.split('.').map((n) => parseInt(n, 10) || 0);
      const b = adoptBundleVersion.split('.').map((n) => parseInt(n, 10) || 0);
      let newer = false;
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] || 0) > (b[i] || 0)) { newer = true; break; }
        if ((a[i] || 0) < (b[i] || 0)) break;
      }
      if (!newer) {
        console.log(`[adopt] bundle (v${adoptBundleVersion}) 사용 (cache v${cached.version} 동일 또는 옛 버전)`);
        return;
      }
      try {
        new Function(cached.code)();
        const w = window as unknown as { adopt?: { adoptStar?: (input: AdoptInput) => AdoptOutput; version?: string } };
        if (typeof w.adopt?.adoptStar === 'function') {
          setAdoptLibOverride({ adoptStar: w.adopt.adoptStar, version: w.adopt.version || cached.version || '?' });
          console.log(`[adopt] gist cache v${cached.version} 사용 (bundle v${adoptBundleVersion})`);
        }
      } catch (e) {
        console.warn('[adopt] cache eval 실패:', (e as Error).message);
      }
    });
  }, []);
  const adoptFn = adoptLibOverride?.adoptStar || adoptStarBundle;
  const adoptVersion = adoptLibOverride?.version || adoptBundleVersion;

  // dp12StarResult — v335E 채택 분기. adopt lib (bundle + gist override) 호출.
  //   ohSorry/recompute/INFOhSorry 3곳이 동일 lib 호출 → drift 방지.
  // group A/B/C 분기 + group C 2-scope max + OSR135 spread gate + OSR135_UNDER blend 다 lib 안에서 처리.
  // 추천 풀 baseStar (ohsorryRecBase) 는 별도로 OSR (newStar) 단독 사용.
  const dp12StarResult = useMemo(() => {
    const star135 = typeof osr135Result?.star === 'number' ? osr135Result.star : null;
    const newStar = typeof osrTieredResult?.star === 'number' ? osrTieredResult.star : null;
    const group = (osrTieredResult?.group as 'A' | 'B' | 'C' | undefined) || null;
    // oldStar (4-scope max) — gist oldOSR 우선, 없으면 자체 dp12StarOldResult fallback
    const oldStarBase: number | null = oldOSRResult?.starEstimate ?? dp12StarOldResult?.star ?? null;
    const starEreterOnly: number | null = oldOSRResult?.ereterOnly ?? null;
    const starLv12Only: number | null = oldOSRResult?.lv12Only ?? null;
    const osr135Stages = osr135Result
      ? { ec: osr135Result.ec, hc: osr135Result.hc, exh: osr135Result.exh }
      : null;

    const r = adoptFn({
      starOld: oldStarBase, starNew: newStar, star135: star135,
      starEreterOnly: starEreterOnly, starLv12Only: starLv12Only,
      osr135Stages: osr135Stages, group: group,
    });

    const adoptSrc = adoptLibOverride ? `gist v${adoptVersion}` : `bundle v${adoptVersion}`;
    const oldSrc = oldOSRResult ? 'gist' : 'local';
    console.log(
      `[★] 채택=${r.adoptedLib ?? 'none'} final=${r.star?.toFixed(3) ?? 'N/A'} | ` +
      `OSR135=${star135?.toFixed(3) ?? 'null'} OSR=${newStar?.toFixed(3) ?? 'null'} ` +
      `old=${r.oldStarUsed?.toFixed(3) ?? 'null'} [${oldSrc}] | ` +
      `group=${group ?? '-'} adopt=${adoptSrc}` +
      (osr135Result ? ` | osr135 ec/hc/exh=${osr135Result.ec.toFixed(2)}/${osr135Result.hc.toFixed(2)}/${osr135Result.exh.toFixed(2)}${r.osr135Trusted ? '' : ' ⚠ spread>2.5'}` : ''),
    );
    if (r.star == null) return dp12StarOldResult;
    return dp12StarOldResult
      ? { ...dp12StarOldResult, star: r.star, _adoptedLib: r.adoptedLib } as typeof dp12StarOldResult & { _adoptedLib?: string | null }
      : null;
  }, [dp12StarOldResult, osrTieredResult, osr135Result, oldOSRResult, adoptFn, adoptLibOverride, adoptVersion]);

  // 추천 baseStar — OSR (v0.0.2) 단독 사용 (D2 표기 ★ 와 분리)
  //   이유: OSR135 의 12점대 over-estimation (+0.46 bias) 을 추천 풀 결정에서 배제
  const ohsorryRecBase = useMemo(() => {
    if (typeof osrTieredResult?.star === 'number') return osrTieredResult.star;
    return dp12StarResult?.star ?? null;
  }, [osrTieredResult, dp12StarResult]);

  // 프로필 (DJ NAME / IIDX ID / SP / DP rank) — 메모리에서 polling
  const profile = useProfile(refluxState);

  // 실력값 추정 + Supabase 업로드 — 1분 주기 (이전엔 Reflux mtime 이벤트 + 3분 upload).
  // 새 동작: 1분마다 tracker.tsv 강제 재읽기 → rows 갱신 → dp12StarResult 자동 재계산 → upload.
  // 호스트 (Electron) 에서만 — PC2 (브라우저 원격) 는 중복 방지로 건너뜀.
  // 최신 profile / star / match / tsvPath 는 ref 로 추적 — 매 interval 시 최신 값 사용.
  const uploadStateRef = useRef({ profile, dp12StarResult, dp12Match, tsvPath });
  uploadStateRef.current = { profile, dp12StarResult, dp12Match, tsvPath };

  useEffect(() => {
    if (IS_BROWSER_REMOTE) return;

    const tryUpload = (trigger: 'auto' | 'manual' | 'initial'): void => {
      const { profile: p, dp12StarResult: s, dp12Match: m } = uploadStateRef.current;
      const tag = `[supabase:${trigger}]`;
      if (!p.iidxId || !p.djName) {
        console.log(`${tag} skip: 프로필 미로드`, { iidxId: p.iidxId, djName: p.djName });
        return;
      }
      if (!/^[A-Z]\d{12}$/.test(p.iidxId)) {
        console.log(`${tag} skip: IIDX ID 형식 불일치 —`, p.iidxId);
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
      void uploadProfile({
        appVersion: APP_VERSION,
        profile: p,
        starResult: s,
        charts: m.charts,
        // 서열표 '미분류' 곡 — charts_json 에만 합쳐 올림 (lamp 통계는 m.charts 만 집계)
        unclassifiedCharts: m.unclassifiedCharts,
      }).then((r) => {
        if (r.ok) console.log(`${tag} 업로드 성공`);
        else console.warn(`${tag} upsert 실패:`, r.error);
      });
    };

    // 콘솔 수동 호출 — updateSupabase()
    (window as unknown as { updateSupabase: () => void }).updateSupabase = (): void =>
      tryUpload('manual');

    // 1분마다: tsv 강제 재읽기 → 500ms 뒤 (useMemo 재계산 시간) 업로드
    const interval = window.setInterval(() => {
      const path = uploadStateRef.current.tsvPath;
      if (path) void loadTsv(path);
      setTimeout(() => tryUpload('auto'), 500);
    }, STAR_REFRESH_INTERVAL_MS);
    console.log(`[supabase] 실력값 추정 + 업로드 활성화 — ${STAR_REFRESH_INTERVAL_MS / 1000}초 간격, 수동: updateSupabase()`);

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
  const initialUploadDoneRef = useRef(false);
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
  const lastRerollEC = useRef(-1);
  const lastRerollHC = useRef(-1);
  const lastRerollEXH = useRef(-1);

  function refreshRecs(prev: RecState, stage: RecStage, charts: RecInputChart[]): RecState {
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
        if (shouldDropFromRecs(stage, c.lampNum, c.djLevel)) {
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
        if (shouldDropFromRecs(stage, c.lampNum, c.djLevel)) {
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
  useEffect(() => {
    if (!dp12Match || ohsorryRecBase == null) return;
    if (lastRerollEC.current !== rerollEC) {
      lastRerollEC.current = rerollEC;
      setRecsEC(buildRecsWithPool(dp12Match.charts, ohsorryRecBase, 'ec', recLevelMode));
    } else {
      setRecsEC((prev) => refreshRecs(prev, 'ec', dp12Match.charts));
    }
  }, [rerollEC, dp12Match, ohsorryRecBase, recLevelMode]);
  useEffect(() => {
    if (!dp12Match || ohsorryRecBase == null) return;
    if (lastRerollHC.current !== rerollHC) {
      lastRerollHC.current = rerollHC;
      setRecsHC(buildRecsWithPool(dp12Match.charts, ohsorryRecBase, 'hc', recLevelMode));
    } else {
      setRecsHC((prev) => refreshRecs(prev, 'hc', dp12Match.charts));
    }
  }, [rerollHC, dp12Match, ohsorryRecBase, recLevelMode]);
  useEffect(() => {
    if (!dp12Match || ohsorryRecBase == null) return;
    if (lastRerollEXH.current !== rerollEXH) {
      lastRerollEXH.current = rerollEXH;
      // EXH 는 ohSorry 스타일 별도 로직 — ★ 낮은 30곡 → rate(=exScore/(noteCount*2)) desc 10곡
      setRecsEXH(buildExhRecs(dp12Match.charts, ohsorryRecBase, recLevelMode));
    } else {
      setRecsEXH((prev) => refreshRecs(prev, 'exh', dp12Match.charts));
    }
  }, [rerollEXH, dp12Match, ohsorryRecBase, recLevelMode]);

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
          {updateDownload.stage === 'idle' && updateInfo.portableUrl && updateInfo.portableName && (
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
          {updateDownload.stage === 'idle' && !updateInfo.portableUrl && updateInfo.htmlUrl && (
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
            osrStar={osrTieredResult?.star ?? null}
          />
          <nav className="tabs">
            <button className={tab === 'dp' ? 'tab active' : 'tab'} onClick={() => setTab('dp')}>
              DP
            </button>
            <button className={tab === 'sp' ? 'tab active' : 'tab'} onClick={() => setTab('sp')}>
              SP
            </button>
            <button
              className={tab === 'dp12' ? 'tab active' : 'tab'}
              onClick={() => setTab('dp12')}
            >
              DP RECOMMEND
            </button>
            <span className="tab-stats">
              {tab === 'dp12'
                ? `${dp12Stats.total}곡 · 시도 ${dp12Stats.attempted} · 클리어 ${dp12Stats.cleared} · HC ${dp12Stats.hard} · EXH ${dp12Stats.exhard} · FC ${dp12Stats.fc}`
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
            {tab === 'dp12' ? (
              <>
                {!IS_BROWSER_REMOTE && devMode && (
                  <StarPanel
                    result={dp12StarResult}
                    allScopes={dp12StarAll}
                    matched={dp12Match?.matched ?? 0}
                    unmatched={dp12Match?.unmatched ?? 0}
                    fitDataCount={dp12StarInputs?.fitDataAll.length ?? 0}
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
                {dp12StarResult && ohsorryRecBase != null && (recsEC.picked.length > 0 || recsHC.picked.length > 0 || recsEXH.picked.length > 0) && (
                  <Recommendations
                    recsEC={recsEC.picked}
                    recsHC={recsHC.picked}
                    recsEXH={recsEXH.picked}
                    baseStar={ohsorryRecBase}
                    levelMode={recLevelMode}
                    onLevelModeChange={handleRecLevelModeChange}
                    onRerollEC={() => setRerollEC((k) => k + 1)}
                    onRerollHC={() => setRerollHC((k) => k + 1)}
                    onRerollEXH={() => setRerollEXH((k) => k + 1)}
                    onPickChart={(r) => {
                      setTab('dp');
                      setScrollTarget({ title: r.title, slot: r.slot, gameLevel: r.gameLevel ?? null });
                    }}
                  />
                )}
                <DpTable
                  lv12Charts={dp12Charts}
                  lv11Charts={dp11Charts}
                  ratingData={ratingData}
                  onPickChart={(target) => {
                    setTab('dp');
                    setScrollTarget(target);
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
const STAGE_INFO: Record<RecStage, { prefix: string; label: string; color: string }> = {
  ec: { prefix: 'EASY', label: '클리어 추천', color: '#52a447' },
  hc: { prefix: 'HARD', label: '클리어 추천', color: '#dc3545' },
  exh: { prefix: 'EX-HARD', label: '클리어 추천', color: '#dcaf45' },
};

const DIFF_COLOR: Record<string, string> = {
  NORMAL: '#1971c2',
  HYPER: '#dcaf45',
  ANOTHER: '#dc3545',
  LEGGENDARIA: '#d678c8',
};

function Recommendations({
  recsEC,
  recsHC,
  recsEXH,
  baseStar,
  levelMode,
  onLevelModeChange,
  onRerollEC,
  onRerollHC,
  onRerollEXH,
  onPickChart,
}: {
  recsEC: RecCandidate[];
  recsHC: RecCandidate[];
  recsEXH: RecCandidate[];
  baseStar: number;
  levelMode: RecLevelMode;
  onLevelModeChange: (mode: RecLevelMode) => void;
  onRerollEC: () => void;
  onRerollHC: () => void;
  onRerollEXH: () => void;
  onPickChart?: (r: RecCandidate) => void;
}): JSX.Element {
  return (
    <div className="rec-area">
      <div className="rec-area-head">
        <h3>
          추천곡 <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>★ {baseStar.toFixed(2)} 기준</span>
        </h3>
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
      <div className="rec-cards">
        <RecCard stage="ec" recs={recsEC} onReroll={onRerollEC} onPickChart={onPickChart} />
        <RecCard stage="hc" recs={recsHC} onReroll={onRerollHC} onPickChart={onPickChart} />
        <RecCard stage="exh" recs={recsEXH} onReroll={onRerollEXH} onPickChart={onPickChart} />
      </div>
    </div>
  );
}

function RecCard({
  stage,
  recs,
  onReroll,
  onPickChart,
}: {
  stage: RecStage;
  recs: RecCandidate[];
  onReroll: () => void;
  onPickChart?: (r: RecCandidate) => void;
}): JSX.Element {
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
      className="rec-card"
      style={{ borderTop: `3px solid ${info.color}` }}
    >
      <summary
        className="rec-card-head"
        onClick={isMobile ? undefined : (e) => e.preventDefault()}
      >
        <span className="rec-card-title">
          <span style={{ color: info.color }}>{info.prefix}</span> {info.label}
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
      </summary>
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
            return (
              <li
                key={`${r.title}|${r.slot}`}
                className={`rec-row rec-${r.category}${onPickChart ? ' rec-row-clickable' : ''}`}
                onClick={onPickChart ? () => onPickChart(r) : undefined}
                role={onPickChart ? 'button' : undefined}
                tabIndex={onPickChart ? 0 : undefined}
                onKeyDown={onPickChart ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPickChart(r); } } : undefined}
                title={onPickChart ? '클릭 시 DP 탭에서 곡명 검색' : undefined}
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
                  {r.title}
                </span>
                <span className="rec-diff" style={{ color: DIFF_COLOR[r.diff] || '#888' }}>
                  {r.diff[0]}
                </span>
                <span className="rec-stagestar">★{displayDiff.toFixed(2)}</span>
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
  allScopes,
  matched,
  unmatched,
  fitDataCount,
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
  result: ReturnType<typeof estimateStar>;
  allScopes: { name: string; res: ReturnType<typeof estimateStar> }[] | null;
  matched: number;
  unmatched: number;
  fitDataCount: number;
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
          별값 계산 표본 부족 — 데이터 점 {fitDataCount}개 / 30개 필요
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          DP ☆12 매칭된 차트: <b>{matched}</b>개 (NP 제외: <b>{matchedNonNp}</b>개) · 미매칭 시도:{' '}
          <b>{unmatched}</b>개
          <br />
          모델은 <b>DP ☆12</b> (= ereter ★11.6~12.7) 만 대상. SP 또는 DP11 이하 플레이는 input 이
          되지 않습니다.
          <br />
          최소 NP 제외 매칭 차트가 ~10개 이상 (= 데이터 점 30개) 있어야 추정 가능.
        </div>
      </div>
    );
  }
  return (
    <div className="star-panel">
      <div className="star-main">
        <span className="star-label">DP ☆12 추정</span>
        <span className="star-value">★ {result.star.toFixed(2)}</span>
      </div>
      <div className="star-detail">
        <span>raw {result.raw.toFixed(2)}</span>
        <span>표본 {result.fitDataCount}</span>
        <span>클리어 {result.nClearedV32}</span>
        <span>lamp {result.validStages.join('/')}</span>
        <span>매칭 {matched} / 미매칭 {unmatched}</span>
        {result.isUnderCutoff && <span className="warning">CUTOFF 미달 (n_cleared &lt; 50)</span>}
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
          {allScopes && (
            <li>
              <b>4종 scope 결과 (max 채택):</b>
              <ul style={{ marginTop: 4, paddingLeft: 16 }}>
                {allScopes.map((s) => {
                  const isMax = s.res != null && result != null && s.res.star === result.star;
                  return (
                    <li
                      key={s.name}
                      style={{
                        color: isMax ? '#0d5fbe' : 'var(--text-secondary, #555)',
                        fontWeight: isMax ? 600 : 400,
                      }}
                    >
                      {s.name}: {s.res
                        ? `★${s.res.star.toFixed(2)} (raw=${s.res.raw.toFixed(2)}, n=${s.res.fitDataCount}, validStages=${s.res.validStages.join('/') || '비어있음'}${s.res.isEcOnlyValid ? ', EC-only' : ''}${s.res.ecOnlyApplied ? '+보정' : ''})`
                        : 'N/A (표본 부족)'}
                      {isMax && ' ← max'}
                    </li>
                  );
                })}
              </ul>
            </li>
          )}
          <li>
            ridge 보정: {result.ridgeCorrection >= 0 ? '+' : ''}
            {result.ridgeCorrection.toFixed(3)}
            {result.ridgeMuted && ' (v3.2.9 ★음소거)'}
          </li>
          <li>
            post 보정: {result.postCorrection >= 0 ? '+' : ''}
            {result.postCorrection.toFixed(3)}
            {result.binImplied &&
              ` (${result.binImplied.stage} bin → ${result.binImplied.implied.toFixed(3)})`}
          </li>
          <li>
            djLevel boost: {result.djBoost >= 0 ? '+' : ''}
            {result.djBoost.toFixed(3)}
            {result.djBoostInfo &&
              ` (M lamp=EC, djLv=${result.djBoostInfo.djLevel}, gap=${result.djBoostInfo.gap.toFixed(2)})`}
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
