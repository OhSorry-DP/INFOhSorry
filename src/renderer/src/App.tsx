import { useEffect, useMemo, useRef, useState } from 'react';
import type { EreterCacheStatus, EreterData, RatingData, RefluxState, SongRow, UpdateInfo, ZasaData } from '../../shared/types';
import './api';
import { DP_SLOTS, extractCharts } from '../../shared/types';
import { buildEreterIndex, lampNum, norm, slotToDiff } from '../../shared/match';
import { estimateStar, type FitDatum, type PoolChart } from '../../shared/star-estimator';
import {
  buildExhRecs,
  buildRecsWithPool,
  STAGE_THRESHOLD,
  type RecCandidate,
  type RecInputChart,
  type RecStage,
} from '../../shared/recommend';
import { lampStyle, letterColor } from './lampStyle';
import ChartTable from './ChartTable';
import Dp12Table from './Dp12Table';
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
      const r = await window.infohsorry.readTsv(path);
      if (r.ok && r.rows && r.rows.length > 0) {
        setRows(r.rows);
        if (r.mtime) {
          lastLoadedMtime.current = r.mtime;
          setTsvMtime(r.mtime);
        }
      }
      // v0.0.15+: 설치 여부 무관 자동 시작 — 미설치면 startAll 안에서 자동 다운로드 + 설치 후 spawn.
      // spawnReflux 가 이미 살아있는 Reflux.exe 감지 시 중복 spawn 안 함.
      // "데이터 불러오기" 버튼은 다운로드 실패 시 retry 용도로 유지.
      if (!state.spawned) {
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

  // DP ☆12 차트만 추출 (별값 추정 모델 input 의 prep)
  // 매칭 우선순위: ereter ★ → zasa ★ (둘 다 없으면 미분류).
  // zasa 만 매칭된 차트는 추천 / ★값 추정엔 사용 X — DP12 격자 분류만 영향.
  const dp12Charts = useMemo(() => {
    const charts = extractCharts(rows, { slots: DP_SLOTS, level: 12 });
    if (!ereterData && !zasaData) return charts;
    const ereterIdx = ereterData ? buildEreterIndex(ereterData.charts).index : null;
    // zasa 인덱스 — 같은 키 형식 (norm(title) + '|' + diff)
    const zasaIdx = new Map<string, { level: number }>();
    if (zasaData) {
      for (const z of zasaData.charts) {
        zasaIdx.set(norm(z.title) + '|' + z.diff, { level: z.level });
      }
    }
    return charts.map((c) => {
      const key = norm(c.title) + '|' + slotToDiff(c.slot);
      const e = ereterIdx?.get(key);
      if (e) return { ...c, ereterLevel: e.level };
      const z = zasaIdx.get(key);
      if (z) return { ...c, ereterLevel: z.level };
      return c;
    });
  }, [rows, ereterData, zasaData]);

  // INFINITAS DP 차트 + ereter ★ 매칭 (LEVEL 11 + LEVEL 12 모두 대상, ★11.6 하한 없음)
  //
  // 우선순위: ereter > ratingMap.
  // - ereter 매칭 곡 → 그 값 그대로 (matched 카운트, gameLevel 필드 없음)
  // - ereter 없을 때만 ratingMap fallback (gameLevel 필드 11/12 표시 → UI 색상 구분)
  // - 둘 다 없으면 unmatched (skip)
  //
  // 별값 추정 input 은 LEVEL 12 ★11.6~12.7 만 (matched ereter 곡들에서 따로 필터),
  // 추천 풀은 lv11+lv12 전곡 (이 charts 배열 그대로) — ohSorry v3.3.3 와 동일.
  const dp12Match = useMemo(() => {
    if (!ereterData) return null;
    const idx = buildEreterIndex(ereterData.charts).index;
    const ratingIdx = new Map<string, RatingData['ratings'][number]>();
    if (ratingData) {
      for (const rt of ratingData.ratings) {
        ratingIdx.set(norm(rt.title) + '|' + rt.diff, rt);
      }
    }
    const charts: RecInputChart[] = [];
    let matched = 0;
    let unmatched = 0;
    let ratingFallbackCount = 0;
    const unmatchedSamples: string[] = [];
    const unmatchedAll: {
      title: string;
      diff: string;
      lamp: string;
      normKey: string;
      ereterCandidates: string[];
    }[] = [];

    // 곡명 norm → ereter 등록된 모든 차트 인덱스 (미매칭 진단용)
    const ereterByTitleNorm = new Map<string, string[]>();
    for (const e of ereterData.charts) {
      const k = norm(e.title);
      if (!ereterByTitleNorm.has(k)) ereterByTitleNorm.set(k, []);
      ereterByTitleNorm.get(k)!.push(`${e.title} [${e.diff}] ★${e.level}`);
    }
    for (const r of rows) {
      for (const slot of DP_SLOTS) {
        const c = r.charts[slot];
        if (!c) continue;
        // LEVEL 11 + LEVEL 12 모두 대상 (ohSorry v3.3.3 와 동일하게 추천 풀 확장)
        if (c.level !== 11 && c.level !== 12) continue;
        const diff = slotToDiff(slot);
        const normKey = norm(r.title) + '|' + diff;
        const e = idx.get(normKey);
        if (e) {
          // ereter 매칭 — 우선순위 최상. ratingMap 안 봄.
          if (e.level > 12.7) continue;
          matched++;
          charts.push({
            title: r.title,
            slot,
            diff,
            level: e.level,
            lamp: c.lamp,
            lampNum: lampNum(c.lamp),
            djLevel: c.letter || null,
            missCount: typeof c.missCount === 'number' ? c.missCount : null,
            ec: e.ec,
            hc: e.hc,
            exh: e.exh,
            ec_n: e.ec_n,
            hc_n: e.hc_n,
            exh_n: e.exh_n,
            // gameLevel 필드 안 채움 (이레터 매칭 곡은 색상 표시 X)
          });
          continue;
        }
        // ereter 매칭 실패 — ratingMap fallback 시도
        const rt = ratingIdx.get(normKey);
        if (rt && typeof rt.zasaLevel === 'number' && rt.zasaLevel <= 12.7) {
          ratingFallbackCount++;
          charts.push({
            title: r.title,
            slot,
            diff,
            level: rt.zasaLevel,
            lamp: c.lamp,
            lampNum: lampNum(c.lamp),
            djLevel: c.letter || null,
            missCount: typeof c.missCount === 'number' ? c.missCount : null,
            ec: typeof rt.estEc === 'number' ? rt.estEc : null,
            hc: typeof rt.estHc === 'number' ? rt.estHc : null,
            exh: typeof rt.estExh === 'number' ? rt.estExh : null,
            ec_n: typeof rt.nEcCleared === 'number' ? rt.nEcCleared : null,
            hc_n: typeof rt.nHcCleared === 'number' ? rt.nHcCleared : null,
            exh_n: 0,
            gameLevel: rt.gameLevel ?? null, // UI 색상 구분
          });
          continue;
        }
        // 둘 다 없음 — unmatched
        if (c.unlocked && c.lamp !== 'NP') {
          unmatched++;
          const titleK = norm(r.title);
          unmatchedAll.push({
            title: r.title,
            diff,
            lamp: c.lamp,
            normKey,
            ereterCandidates: ereterByTitleNorm.get(titleK) ?? [],
          });
          if (unmatchedSamples.length < 10) {
            unmatchedSamples.push(`${r.title} [${diff}] (lamp=${c.lamp})`);
          }
        }
      }
    }
    if (ratingFallbackCount > 0) {
      console.log(`[dp12Match] ratingMap fallback: ${ratingFallbackCount}곡 (ereter 미등록 lv11/lv12 추정)`);
    }
    // dev 디버그: 미매칭 곡 전체 목록 + ereter 의 norm 키 후보 console 출력
    if (unmatchedAll.length > 0) {
      console.group(`[dp12Match] 미매칭 ${unmatchedAll.length}곡 (★12 + 시도한 곡)`);
      console.log(unmatchedAll.map((u) => `${u.title} [${u.diff}] (lamp=${u.lamp})`).join('\n'));
      // 같은 곡명의 ereter 후보 — diff 종류는 다를 수 있음
      const titleNorm = new Map<string, string[]>();
      for (const e of ereterData.charts) {
        const k = norm(e.title);
        if (!titleNorm.has(k)) titleNorm.set(k, []);
        titleNorm.get(k)!.push(`${e.title} [${e.diff}] ★${e.level}`);
      }
      console.group('미매칭 곡명별 — ereter 동일 norm 후보 (있으면 다른 diff 가능성, 없으면 ereter 미등록)');
      for (const u of unmatchedAll) {
        const tk = u.normKey.split('|')[0];
        const cands = titleNorm.get(tk);
        if (cands && cands.length > 0) {
          console.log(`  '${u.title}' [${u.diff}] → ereter 후보: ${cands.join(' / ')}`);
        } else {
          console.log(`  '${u.title}' [${u.diff}] → ereter 곡명 자체 없음 (norm '${tk}')`);
        }
      }
      console.groupEnd();
      console.groupEnd();
      // 전역 노출 (개발자가 console 에서 window.__dp_unmatched 로 다시 볼 수 있게)
      (window as unknown as { __dp_unmatched: typeof unmatchedAll }).__dp_unmatched = unmatchedAll;
    }
    return { charts, matched, unmatched, unmatchedSamples, unmatchedAll };
  }, [rows, ereterData, ratingData]);

  // 별값 추정 input — dp12Match 에서 derive
  // v3.3.3: 4종 fitData scope 동시 수집 (ohSorry 와 동일).
  //   ereter 매칭 곡 → c.gameLevel 안 채움 (모두 lv12)
  //   ratingMap fallback → c.gameLevel = 11 / 12
  //
  //   - fitDataEreterOnly: 이레터 매칭 (gameLevel == null) 곡만
  //   - fitDataLv12Only:   이레터 + ratingMap gameLevel === 12 (= 모든 lv12)
  //   - fitDataAll:        이레터 + ratingMap 모두 (lv11+lv12 통합 = 11.6+ 전체)
  const dp12StarInputs = useMemo(() => {
    if (!dp12Match) return null;
    const fitDataEreterOnly: FitDatum[] = [];
    const fitDataLv12Only: FitDatum[] = [];
    const fitDataAll: FitDatum[] = [];
    const poolCharts: PoolChart[] = [];
    for (const c of dp12Match.charts) {
      poolCharts.push({
        lampNum: c.lampNum,
        level: c.level,
        djLevel: c.djLevel,
        ec: c.ec,
        hc: c.hc,
        exh: c.exh,
      });
      // 별값 추정 input 은 ★11.6~12.7 만 (ohSorry v3.3.3 와 동일).
      if (c.lampNum > 0 && c.level >= 11.6 && c.level <= 12.7) {
        const items: FitDatum[] = [];
        if (typeof c.ec === 'number') items.push({ d: c.ec, p: c.lampNum >= 3 ? 1 : 0, stage: 'ec' });
        if (typeof c.hc === 'number') items.push({ d: c.hc, p: c.lampNum >= 5 ? 1 : 0, stage: 'hc' });
        if (typeof c.exh === 'number') items.push({ d: c.exh, p: c.lampNum >= 6 ? 1 : 0, stage: 'exh' });
        const isEreter = c.gameLevel == null;
        const isLv12 = c.gameLevel == null || c.gameLevel === 12;
        fitDataAll.push(...items);
        if (isLv12) fitDataLv12Only.push(...items);
        if (isEreter) fitDataEreterOnly.push(...items);
      }
    }
    // useOnlyLv12 분기 — LEVEL 12 (이레터 + lv12 rating) 플레이 ≥ 30
    const nLv12Played = dp12Match.charts.filter(
      (c) => (c.gameLevel == null || c.gameLevel === 12) && c.lampNum > 0,
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

  // max-of-4 채택 — 저렙 fallback (★0.01) 자동 보완. dp12StarResult 는 max 결과.
  const dp12StarResult = useMemo(() => {
    if (!dp12StarAll) return null;
    const valid = dp12StarAll.filter((x) => x.res != null);
    if (valid.length === 0) return null;
    valid.sort((a, b) => (b.res!.star ?? 0) - (a.res!.star ?? 0));
    return valid[0].res;
  }, [dp12StarAll]);

  // 2nd 채택 — 3 unique scope (이레터 / lv12 / all-11.6+) 중 두번째로 큰 값.
  // primary 는 위 3개 중 하나의 복사이므로 dedup 위해 제외.
  const dp12StarSecond = useMemo(() => {
    if (!dp12StarAll) return null;
    const scopes = dp12StarAll.filter((x) => x.name !== 'primary' && x.res != null);
    if (scopes.length < 2) return null;
    scopes.sort((a, b) => (b.res!.star ?? 0) - (a.res!.star ?? 0));
    return { name: scopes[1].name, result: scopes[1].res };
  }, [dp12StarAll]);

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
    const threshold = STAGE_THRESHOLD[stage];
    const map = new Map<string, RecInputChart>();
    for (const c of charts) map.set(c.title + '|' + c.slot, c);
    // picked: 클리어된 곡만 제거. lamp / missCount 가 바뀐 경우만 새 객체 생성 (identity 보존).
    let droppedCount = 0;
    let pickedChanged = false;
    const updatedPicked: RecCandidate[] = [];
    for (const r of prev.picked) {
      const c = map.get(r.title + '|' + r.slot);
      if (c) {
        if (c.lampNum >= threshold) {
          droppedCount++;
          pickedChanged = true;
          continue;
        }
        if (c.lamp !== r.currentLamp || c.missCount !== r.missCount) {
          updatedPicked.push({ ...r, currentLamp: c.lamp, missCount: c.missCount });
          pickedChanged = true;
        } else {
          updatedPicked.push(r); // 변화 없음 → 같은 ref 재사용
        }
      } else {
        updatedPicked.push(r); // 매칭 안 됨 — 이전 그대로
      }
    }
    let poolChanged = false;
    const updatedPool: RecCandidate[] = [];
    for (const r of prev.pool) {
      const c = map.get(r.title + '|' + r.slot);
      if (c) {
        if (c.lampNum >= threshold) {
          poolChanged = true;
          continue;
        }
        if (c.lamp !== r.currentLamp || c.missCount !== r.missCount) {
          updatedPool.push({ ...r, currentLamp: c.lamp, missCount: c.missCount });
          poolChanged = true;
        } else {
          updatedPool.push(r);
        }
      } else {
        updatedPool.push(r);
      }
    }
    // 클리어로 빠진 만큼만 풀에서 보충
    while (droppedCount > 0 && updatedPool.length > 0) {
      const next = updatedPool.shift();
      if (next) updatedPicked.push(next);
      droppedCount--;
      poolChanged = true;
    }
    // 변화 없으면 prev state ref 그대로 반환 → setRecs 가 noop, React 재렌더 안 함
    if (!pickedChanged && !poolChanged) {
      return prev;
    }
    // 변화 있을 때만 정렬:
    //   EC/HC — diffValue (★) asc
    //   EXH   — missCount asc (null 뒤로) — buildExhRecs 와 동일한 순서 유지
    if (stage === 'exh') {
      updatedPicked.sort((a, b) => {
        const ma = a.missCount;
        const mb = b.missCount;
        if (ma == null && mb == null) return 0;
        if (ma == null) return 1;
        if (mb == null) return -1;
        return ma - mb;
      });
    } else {
      updatedPicked.sort((a, b) => a.diffValue - b.diffValue);
    }
    return { picked: updatedPicked, pool: updatedPool };
  }

  useEffect(() => {
    if (!dp12Match || !dp12StarResult) return;
    if (lastRerollEC.current !== rerollEC) {
      lastRerollEC.current = rerollEC;
      setRecsEC(buildRecsWithPool(dp12Match.charts, dp12StarResult.star, 'ec'));
    } else {
      setRecsEC((prev) => refreshRecs(prev, 'ec', dp12Match.charts));
    }
  }, [rerollEC, dp12Match, dp12StarResult]);
  useEffect(() => {
    if (!dp12Match || !dp12StarResult) return;
    if (lastRerollHC.current !== rerollHC) {
      lastRerollHC.current = rerollHC;
      setRecsHC(buildRecsWithPool(dp12Match.charts, dp12StarResult.star, 'hc'));
    } else {
      setRecsHC((prev) => refreshRecs(prev, 'hc', dp12Match.charts));
    }
  }, [rerollHC, dp12Match, dp12StarResult]);
  useEffect(() => {
    if (!dp12Match || !dp12StarResult) return;
    if (lastRerollEXH.current !== rerollEXH) {
      lastRerollEXH.current = rerollEXH;
      // EXH 는 ohSorry 스타일 별도 로직 — ★ 낮은 30곡 → missCount 낮은 순 10곡
      setRecsEXH(buildExhRecs(dp12Match.charts, dp12StarResult.star));
    } else {
      setRecsEXH((prev) => refreshRecs(prev, 'exh', dp12Match.charts));
    }
  }, [rerollEXH, dp12Match, dp12StarResult]);

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
      {updateInfo && updateInfo.hasUpdate && updateInfo.latestVersion && updateInfo.htmlUrl && (
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
          }}
        >
          <span>
            🆕 새 버전 <b>v{updateInfo.latestVersion}</b> 있음 (현재 v{updateInfo.currentVersion})
          </span>
          <a
            href={updateInfo.htmlUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: '#212529', textDecoration: 'underline' }}
          >
            다운로드 페이지 열기 →
          </a>
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
      <RefluxLog state={refluxState} />

      {error && <div className="error">에러: {error}</div>}

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
            secondHighest={dp12StarSecond}
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
                    ereterStatus={ereterStatus}
                    ereterBusy={ereterBusy}
                    onRefreshEreter={() => refreshEreter(true)}
                  />
                )}
                {dp12StarResult && (recsEC.picked.length > 0 || recsHC.picked.length > 0 || recsEXH.picked.length > 0) && (
                  <Recommendations
                    recsEC={recsEC.picked}
                    recsHC={recsHC.picked}
                    recsEXH={recsEXH.picked}
                    baseStar={dp12StarResult.star}
                    onRerollEC={() => setRerollEC((k) => k + 1)}
                    onRerollHC={() => setRerollHC((k) => k + 1)}
                    onRerollEXH={() => setRerollEXH((k) => k + 1)}
                  />
                )}
                <Dp12Table charts={dp12Charts} />
              </>
            ) : (
              <ChartTable rows={rows} style={tab} />
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
  onRerollEC,
  onRerollHC,
  onRerollEXH,
}: {
  recsEC: RecCandidate[];
  recsHC: RecCandidate[];
  recsEXH: RecCandidate[];
  baseStar: number;
  onRerollEC: () => void;
  onRerollHC: () => void;
  onRerollEXH: () => void;
}): JSX.Element {
  return (
    <div className="rec-area">
      <div className="rec-area-head">
        <h3>
          추천곡 <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>★ {baseStar.toFixed(2)} 기준</span>
        </h3>
      </div>
      <div className="rec-cards">
        <RecCard stage="ec" recs={recsEC} onReroll={onRerollEC} />
        <RecCard stage="hc" recs={recsHC} onReroll={onRerollHC} />
        <RecCard stage="exh" recs={recsEXH} onReroll={onRerollEXH} />
      </div>
    </div>
  );
}

function RecCard({
  stage,
  recs,
  onReroll,
}: {
  stage: RecStage;
  recs: RecCandidate[];
  onReroll: () => void;
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
            // ratingMap fallback 곡 색상 구분: lv11 → 진한 연두 (#9ccc65) / lv12 → 하늘색 (#87ceeb)
            // ereter 매칭 곡은 gameLevel 비어있어서 기본 색.
            const titleColor =
              r.gameLevel === 11 ? '#9ccc65' :
              r.gameLevel === 12 ? '#87ceeb' : undefined;
            const titleTooltip =
              r.gameLevel === 11 ? 'ohSorry 추정 ★ (게임 LEVEL 11, ereter 미등록)' :
              r.gameLevel === 12 ? 'ohSorry 추정 ★ (게임 LEVEL 12, ereter 미등록)' : undefined;
            return (
              <li key={`${r.title}|${r.slot}`} className={`rec-row rec-${r.category}`}>
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
                <span className="rec-stagestar">★{r.diffValue.toFixed(2)}</span>
                {r.category === 'exh-near' && (
                  <span className="rec-misscount" title="미스 카운트 (BP)">
                    BP{r.missCount ?? '?'}
                  </span>
                )}
                <span className="rec-lamp" style={{ color: ls.color }}>
                  {ls.label}
                </span>
                <span className="rec-level">☆{r.level.toFixed(1)}</span>
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
