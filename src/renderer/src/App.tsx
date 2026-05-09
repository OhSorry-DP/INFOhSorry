import { useEffect, useMemo, useRef, useState } from 'react';
import type { EreterCacheStatus, EreterData, RefluxState, SongRow, ZasaData } from '../../shared/types';
import './api';
import { DP_SLOTS, extractCharts } from '../../shared/types';
import { buildEreterIndex, lampNum, norm, slotToDiff } from '../../shared/match';
import { estimateStar, type FitDatum, type PoolChart } from '../../shared/star-estimator';
import {
  buildRecsWithPool,
  STAGE_THRESHOLD,
  type RecCandidate,
  type RecInputChart,
  type RecStage,
} from '../../shared/recommend';
import { lampStyle, letterColor } from './lampStyle';
import ChartTable from './ChartTable';
import Dp12Table from './Dp12Table';

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
  const [tab, setTab] = useState<Tab>('sp');
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
      // 설치돼있으면 자동 시작. spawnReflux 가 이미 살아있는 Reflux.exe 감지 시 중복 spawn 안 함.
      if (state.installed && !state.spawned) {
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

  // Reflux 가 새 dump 를 신호하면 (stage='ready' + lastTsvMtime 갱신) 자동 reload
  useEffect(() => {
    const m = refluxState.lastTsvMtime ?? 0;
    if (refluxState.stage === 'ready' && m && m !== lastLoadedMtime.current && tsvPath) {
      lastLoadedMtime.current = m;
      void loadTsv(tsvPath);
    }
  }, [refluxState, tsvPath]);

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

  // INFINITAS DP 차트 + ereter ★ 매칭 (★11.6~12.7 = LEVEL 12 만)
  // 별값 추정 / 추천곡의 단일 source.
  const dp12Match = useMemo(() => {
    if (!ereterData) return null;
    const idx = buildEreterIndex(ereterData.charts).index;
    const charts: RecInputChart[] = [];
    let matched = 0;
    let unmatched = 0;
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
        // INFINITAS LEVEL 12 만 대상 — LEVEL 1~11 차트는 ereter 매칭 시도조차 X
        if (c.level !== 12) continue;
        const diff = slotToDiff(slot);
        const normKey = norm(r.title) + '|' + diff;
        const e = idx.get(normKey);
        if (!e) {
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
          continue;
        }
        if (e.level < 11.6 || e.level > 12.7) continue;
        matched++;
        charts.push({
          title: r.title,
          slot,
          diff,
          level: e.level,
          lamp: c.lamp,
          lampNum: lampNum(c.lamp),
          djLevel: c.letter || null,
          ec: e.ec,
          hc: e.hc,
          exh: e.exh,
          ec_n: e.ec_n,
          hc_n: e.hc_n,
          exh_n: e.exh_n,
        });
      }
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
  }, [rows, ereterData]);

  // 별값 추정 input — dp12Match 에서 derive
  const dp12StarInputs = useMemo(() => {
    if (!dp12Match) return null;
    const fitData: FitDatum[] = [];
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
      if (c.lampNum > 0) {
        if (typeof c.ec === 'number') fitData.push({ d: c.ec, p: c.lampNum >= 3 ? 1 : 0, stage: 'ec' });
        if (typeof c.hc === 'number') fitData.push({ d: c.hc, p: c.lampNum >= 5 ? 1 : 0, stage: 'hc' });
        if (typeof c.exh === 'number') fitData.push({ d: c.exh, p: c.lampNum >= 6 ? 1 : 0, stage: 'exh' });
      }
    }
    return { fitData, poolCharts };
  }, [dp12Match]);

  const dp12StarResult = useMemo(() => {
    if (!dp12StarInputs) return null;
    return estimateStar(dp12StarInputs.fitData, dp12StarInputs.poolCharts);
  }, [dp12StarInputs]);

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
    // picked: 클리어된 곡만 제거 (map 에 없으면 이전 rec 그대로 유지 — 일시적 매칭 변동 방어).
    let droppedCount = 0;
    const updatedPicked: RecCandidate[] = [];
    for (const r of prev.picked) {
      const c = map.get(r.title + '|' + r.slot);
      if (c) {
        if (c.lampNum >= threshold) {
          droppedCount++;
          continue;
        }
        updatedPicked.push({ ...r, currentLamp: c.lamp });
      } else {
        // 매칭 안 됨 — 이전 정보 그대로 유지 (false-drop 방지)
        updatedPicked.push(r);
      }
    }
    const updatedPool: RecCandidate[] = [];
    for (const r of prev.pool) {
      const c = map.get(r.title + '|' + r.slot);
      if (c) {
        if (c.lampNum >= threshold) continue;
        updatedPool.push({ ...r, currentLamp: c.lamp });
      } else {
        updatedPool.push(r);
      }
    }
    // 클리어로 빠진 만큼만 풀에서 보충 (강제 10개 채우기 X — picked 가 줄어들면 그대로 둠)
    while (droppedCount > 0 && updatedPool.length > 0) {
      const next = updatedPool.shift();
      if (next) updatedPicked.push(next);
      droppedCount--;
    }
    // 정렬은 picked 가 실제로 변경된 경우만 (성능 + identity 보존)
    if (updatedPicked.length !== prev.picked.length || updatedPicked.some((r, i) => r !== prev.picked[i])) {
      updatedPicked.sort((a, b) => {
        if (a.category !== b.category) return a.category === 'challenge' ? -1 : 1;
        return b.diffValue - a.diffValue;
      });
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
      setRecsEXH(buildRecsWithPool(dp12Match.charts, dp12StarResult.star, 'exh'));
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
      <header className="app-header">
        <div className="title">
          <h1>
            IIDX INFINITAS DP Play Data Viewer
            <span className="by-author"> - by오소리</span>
          </h1>
        </div>
        <div className="actions">
          <StageSpinner state={refluxState} />
          {(rows.length === 0 || !refluxState.installed) && (
            <button className="btn-primary" onClick={startReflux} disabled={busy}>
              데이터 불러오기
            </button>
          )}
        </div>
      </header>

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
          <nav className="tabs">
            <button className={tab === 'sp' ? 'tab active' : 'tab'} onClick={() => setTab('sp')}>
              SP
            </button>
            <button className={tab === 'dp' ? 'tab active' : 'tab'} onClick={() => setTab('dp')}>
              DP
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
          </nav>

          <main className="content">
            {tab === 'dp12' ? (
              <>
                <StarPanel
                  result={dp12StarResult}
                  matched={dp12Match?.matched ?? 0}
                  unmatched={dp12Match?.unmatched ?? 0}
                  fitDataCount={dp12StarInputs?.fitData.length ?? 0}
                  matchedNonNp={dp12Match?.charts.filter((c) => c.lampNum > 0).length ?? 0}
                  ereterReady={!!ereterData}
                  unmatchedSamples={dp12Match?.unmatchedSamples ?? []}
                  unmatchedAll={dp12Match?.unmatchedAll ?? []}
                  ereterStatus={ereterStatus}
                  ereterBusy={ereterBusy}
                  onRefreshEreter={() => refreshEreter(true)}
                />
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
          추천곡 <span style={{ fontWeight: 400, color: '#888', fontSize: 12 }}>★ {baseStar.toFixed(2)} 기준</span>
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
  // 모바일에서만 collapsible — 데스크탑은 항상 펴진 상태로 고정 (toggle 비활성).
  const [isMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches,
  );
  const [openMobile, setOpenMobile] = useState(false);
  return (
    <details
      className="rec-card"
      open={isMobile ? openMobile : true}
      onToggle={isMobile ? (e) => setOpenMobile(e.currentTarget.open) : undefined}
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
            return (
              <li key={`${r.title}|${r.slot}`} className={`rec-row rec-${r.category}`}>
                <span className="rec-cat" title={r.category === 'challenge' ? '도전' : '정리'}>
                  {r.category === 'challenge' ? '↑' : '↓'}
                </span>
                <span className="rec-title">{r.title}</span>
                <span className="rec-diff" style={{ color: DIFF_COLOR[r.diff] || '#888' }}>
                  {r.diff[0]}
                </span>
                <span className="rec-stagestar">★{r.diffValue.toFixed(2)}</span>
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
        <div style={{ fontSize: 11.5, color: '#666', lineHeight: 1.6 }}>
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
        <span className="star-label">DP ☆12 추정 ★</span>
        <span className="star-value">{result.star.toFixed(2)}</span>
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
                  <li key={s} style={{ color: '#888' }}>
                    {s}
                  </li>
                ))}
                {unmatchedAll.length > unmatchedSamples.length && (
                  <li style={{ color: '#aaa', fontSize: 11 }}>
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
