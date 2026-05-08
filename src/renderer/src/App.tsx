import { useEffect, useMemo, useRef, useState } from 'react';
import type { EreterCacheStatus, EreterData, RefluxState, SongRow } from '../../shared/types';
import './api';
import { DP_SLOTS, extractCharts } from '../../shared/types';
import { buildEreterIndex, lampNum, norm, slotToDiff } from '../../shared/match';
import { estimateStar, type FitDatum, type PoolChart } from '../../shared/star-estimator';
import {
  buildRecs,
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

  // 마운트 시: Reflux state 구독 + tsvPath / 현재 state 가져오기 + tracker.tsv 자동 복원
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

  // 수동 TSV 선택 (디버깅 / 다른 위치의 TSV 파일 보고 싶을 때)
  async function pickAndLoad(): Promise<void> {
    const picked = await window.infohsorry.pickTsv();
    if (!picked) return;
    setTsvPath(picked);
    await loadTsv(picked);
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
  // ereter 매칭되는 차트는 ereterLevel (★ 소수) 도 추가
  const dp12Charts = useMemo(() => {
    const charts = extractCharts(rows, { slots: DP_SLOTS, level: 12 });
    if (!ereterData) return charts;
    const idx = buildEreterIndex(ereterData.charts).index;
    return charts.map((c) => {
      const e = idx.get(norm(c.title) + '|' + slotToDiff(c.slot));
      return e ? { ...c, ereterLevel: e.level } : c;
    });
  }, [rows, ereterData]);

  // INFINITAS DP 차트 + ereter ★ 매칭 (★11.6~12.7 = LEVEL 12 만)
  // 별값 추정 / 추천곡의 단일 source.
  const dp12Match = useMemo(() => {
    if (!ereterData) return null;
    const idx = buildEreterIndex(ereterData.charts).index;
    const charts: RecInputChart[] = [];
    let matched = 0;
    let unmatched = 0;
    const unmatchedSamples: string[] = [];
    for (const r of rows) {
      for (const slot of DP_SLOTS) {
        const c = r.charts[slot];
        if (!c) continue;
        // INFINITAS LEVEL 12 만 대상 — LEVEL 1~11 차트는 ereter 매칭 시도조차 X
        if (c.level !== 12) continue;
        const e = idx.get(norm(r.title) + '|' + slotToDiff(slot));
        if (!e) {
          if (c.unlocked && c.lamp !== 'NP') {
            unmatched++;
            if (unmatchedSamples.length < 10) {
              unmatchedSamples.push(`${r.title} [${slotToDiff(slot)}] (lamp=${c.lamp})`);
            }
          }
          continue;
        }
        if (e.level < 11.6 || e.level > 12.7) continue;
        matched++;
        charts.push({
          title: r.title,
          slot,
          diff: slotToDiff(slot),
          level: e.level,
          lamp: c.lamp,
          lampNum: lampNum(c.lamp),
          djLevel: c.letter || null,
          ec: e.ec,
          hc: e.hc,
          exh: e.exh,
        });
      }
    }
    return { charts, matched, unmatched, unmatchedSamples };
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

  // 추천곡 — rerollKey 가 바뀔 때마다 새로 random pick
  const [rerollKey, setRerollKey] = useState(0);
  const recsEC = useMemo(
    () => (dp12Match && dp12StarResult ? buildRecs(dp12Match.charts, dp12StarResult.star, 'ec') : []),
    [dp12Match, dp12StarResult, rerollKey],
  );
  const recsHC = useMemo(
    () => (dp12Match && dp12StarResult ? buildRecs(dp12Match.charts, dp12StarResult.star, 'hc') : []),
    [dp12Match, dp12StarResult, rerollKey],
  );
  const recsEXH = useMemo(
    () => (dp12Match && dp12StarResult ? buildRecs(dp12Match.charts, dp12StarResult.star, 'exh') : []),
    [dp12Match, dp12StarResult, rerollKey],
  );

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
            IIDX INFINITAS Play Data Viewer
            <span className="by-author"> - by오소리</span>
          </h1>
        </div>
        <div className="actions">
          <button className="btn-primary" onClick={startReflux} disabled={busy}>
            데이터 불러오기
          </button>
          <button onClick={pickAndLoad} disabled={busy} title="다른 TSV 파일 직접 선택">
            TSV 직접 선택
          </button>
          <button
            onClick={() => void window.infohsorry.reflux.openDir()}
            title="Reflux 작업 폴더를 탐색기로 열기"
          >
            폴더 열기
          </button>
        </div>
      </header>

      <ProgressBar state={refluxState} />

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
                  ereterStatus={ereterStatus}
                  ereterBusy={ereterBusy}
                  onRefreshEreter={() => refreshEreter(true)}
                />
                {dp12StarResult && (recsEC.length > 0 || recsHC.length > 0 || recsEXH.length > 0) && (
                  <Recommendations
                    recsEC={recsEC}
                    recsHC={recsHC}
                    recsEXH={recsEXH}
                    baseStar={dp12StarResult.star}
                    onReroll={() => setRerollKey((k) => k + 1)}
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
const STAGE_INFO: Record<RecStage, { title: string; color: string }> = {
  ec: { title: 'EASY 클리어', color: '#52a447' },
  hc: { title: 'HARD 클리어', color: '#dc3545' },
  exh: { title: 'EX-HARD 클리어', color: '#dcaf45' },
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
  onReroll,
}: {
  recsEC: RecCandidate[];
  recsHC: RecCandidate[];
  recsEXH: RecCandidate[];
  baseStar: number;
  onReroll: () => void;
}): JSX.Element {
  return (
    <div className="rec-area">
      <div className="rec-area-head">
        <h3>
          추천곡 <span style={{ fontWeight: 400, color: '#888', fontSize: 12 }}>★ {baseStar.toFixed(2)} 기준</span>
        </h3>
        <button onClick={onReroll} title="랜덤 추첨 다시">
          ↻ 다시 뽑기
        </button>
      </div>
      <div className="rec-cards">
        <RecCard stage="ec" recs={recsEC} />
        <RecCard stage="hc" recs={recsHC} />
        <RecCard stage="exh" recs={recsEXH} />
      </div>
    </div>
  );
}

function RecCard({ stage, recs }: { stage: RecStage; recs: RecCandidate[] }): JSX.Element {
  const info = STAGE_INFO[stage];
  return (
    <div className="rec-card" style={{ borderTop: `3px solid ${info.color}` }}>
      <div className="rec-card-head">
        <span className="rec-card-title" style={{ color: info.color }}>
          {info.title}
        </span>
        <span className="rec-card-count">{recs.length}곡</span>
      </div>
      {recs.length === 0 ? (
        <div className="rec-empty">추천할 곡 없음 (이미 다 클리어했거나 풀 부족)</div>
      ) : (
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// DP ☆12 별값 결과 패널 (ohSorry v3.2.9 모델)
// ============================================================
function StarPanel({
  result,
  matched,
  unmatched,
  fitDataCount,
  matchedNonNp,
  ereterReady,
  unmatchedSamples,
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
          {unmatchedSamples.length > 0 && (
            <li>
              미매칭 샘플 ({unmatchedSamples.length}건):
              <ul>
                {unmatchedSamples.map((s) => (
                  <li key={s} style={{ color: '#888' }}>
                    {s}
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
        <div className="star-ereter">
          <EreterBar
            status={ereterStatus}
            busy={ereterBusy}
            onRefresh={onRefreshEreter}
          />
        </div>
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
// 단계별 진행 상태 표시
// ============================================================
function ProgressBar({ state }: { state: RefluxState }): JSX.Element | null {
  // idle / ready 일 때는 진행바 숨김 — idle 은 시작 전, ready 는 완료 후라 둘 다 방해 X
  if (state.stage === 'idle' || state.stage === 'ready') return null;

  const steps = [
    {
      key: 'install',
      label: 'Reflux 다운로드',
      status: state.installed ? 'done' : state.stage === 'downloading' ? 'active' : 'pending',
    },
    {
      key: 'spawn',
      label: 'Reflux 실행',
      status: state.spawned ? 'done' : state.stage === 'starting' ? 'active' : 'pending',
    },
    {
      key: 'hook',
      label: 'INFINITAS hook',
      status: ['hooked', 'ready'].includes(state.stage)
        ? 'done'
        : state.stage === 'hooking'
        ? 'active'
        : 'pending',
    },
    {
      key: 'dump',
      label: '첫 데이터 dump',
      // 'ready' 일 때는 위에서 early return 으로 진행바 자체가 숨겨짐 — 여기 도달하면 항상 pending
      status: 'pending' as const,
    },
  ];

  return (
    <div className="progress">
      {steps.map((s) => (
        <div key={s.key} className={`step step-${s.status}`}>
          <span className="step-mark">
            {s.status === 'done' ? 'O' : s.status === 'active' ? '...' : '-'}
          </span>
          <span className="step-label">{s.label}</span>
        </div>
      ))}
      {state.stage === 'downloading' && state.download && (
        <div className="dl-progress">
          {(state.download.bytes / 1024 / 1024).toFixed(1)} /{' '}
          {(state.download.total / 1024 / 1024).toFixed(1)} MB
        </div>
      )}
      {state.stage === 'hooking' && (
        <div className="hint-line">INFINITAS 가 켜져있는지 확인해주세요.</div>
      )}
      {state.stage === 'hooked' && (
        <div className="hint-line">게임의 곡 선택 화면에 한 번 가시면 데이터가 옵니다.</div>
      )}
    </div>
  );
}
