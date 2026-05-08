import { useEffect, useMemo, useRef, useState } from 'react';
import type { EreterCacheStatus, RefluxState, SongRow } from '../../shared/types';
import { DP_SLOTS, extractCharts } from '../../shared/types';
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

  // ereter ★ 데이터 캐시 상태 + 갱신 진행 표시
  const [ereterStatus, setEreterStatus] = useState<EreterCacheStatus | null>(null);
  const [ereterBusy, setEreterBusy] = useState(false);

  // 마운트 시:
  //   1. Reflux state 구독 시작
  //   2. 현재 tsvPath / 현재 state 한 번 가져오기
  //   3. 디스크에 tracker.tsv 가 이미 있으면 → 즉시 읽어서 표시 (이전 세션 데이터 복원)
  useEffect(() => {
    const off = window.infohsorry.reflux.onState((s) => setRefluxState(s));
    void (async () => {
      const path = await window.infohsorry.reflux.getTsvPath();
      setTsvPath(path);
      const state = await window.infohsorry.reflux.getState();
      setRefluxState(state);
      // 자동 복원 — 파일 없으면 ok:false 반환되니 그냥 ignore
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

  // 마운트 시 ereter 캐시 상태 확인 — 24h 지났거나 데이터 없으면 자동 갱신
  useEffect(() => {
    void (async () => {
      const status = await window.infohsorry.ereter.status();
      setEreterStatus(status);
      if (status.isStale || !status.exists) {
        // 백그라운드 자동 갱신 (force=false 이지만 stale 이라 fetch 됨)
        await refreshEreter(false);
      }
    })();
  }, []);

  // ereter 갱신 — force=true 면 24h 안 지났어도 강제 갱신
  async function refreshEreter(force: boolean): Promise<void> {
    setEreterBusy(true);
    try {
      const r = await window.infohsorry.ereter.get(force);
      if (!r.ok) setError(r.error || 'ereter 갱신 실패');
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
  const dp12Charts = useMemo(
    () => extractCharts(rows, { slots: DP_SLOTS, level: 12 }),
    [rows],
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
      if (['Easy', 'Clear', 'Hard', 'ExHard', 'FullCombo'].includes(c.lamp)) cleared++;
      if (['Hard', 'ExHard', 'FullCombo'].includes(c.lamp)) hard++;
      if (['ExHard', 'FullCombo'].includes(c.lamp)) exhard++;
      if (c.lamp === 'FullCombo') fc++;
    }
    return { total, attempted, cleared, hard, exhard, fc };
  }, [dp12Charts]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="title">
          <h1>INFOhSorry</h1>
          <span className="subtitle">IIDX INFINITAS · Reflux 통합 뷰어</span>
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

      <EreterBar status={ereterStatus} busy={ereterBusy} onRefresh={() => refreshEreter(true)} />

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
              SINGLE PLAY
            </button>
            <button className={tab === 'dp' ? 'tab active' : 'tab'} onClick={() => setTab('dp')}>
              DOUBLE PLAY
            </button>
            <button
              className={tab === 'dp12' ? 'tab active' : 'tab'}
              onClick={() => setTab('dp12')}
            >
              DP ☆12 분석
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
              <Dp12Table charts={dp12Charts} />
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
