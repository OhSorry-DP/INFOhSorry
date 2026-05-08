import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefluxState, SongRow } from '../../shared/types';
import ChartTable from './ChartTable';

type Tab = 'sp' | 'dp';

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

  // 마지막으로 reload 한 mtime — 같은 mtime 으로 중복 reload 방지
  const lastLoadedMtime = useRef<number>(0);

  // 마운트 시: 현재 Reflux 상태 + tracker.tsv 경로 동기화
  useEffect(() => {
    void window.infohsorry.reflux.getTsvPath().then(setTsvPath);
    void window.infohsorry.reflux.getState().then(setRefluxState);
    const off = window.infohsorry.reflux.onState((s) => setRefluxState(s));
    return off;
  }, []);

  // tracker.tsv 가 갱신될 때마다 자동 reload
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

  // 통계
  const stats = useMemo(() => {
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
        </div>
      </header>

      <ProgressBar state={refluxState} />

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
            <span className="tab-stats">
              {rows.length}곡 · {stats.unlocked}/{stats.total} unlock · {stats.played} played
              {refluxState.lastTsvMtime && (
                <span className="updated-at">
                  {' '}
                  · 갱신 {new Date(refluxState.lastTsvMtime).toLocaleTimeString()}
                </span>
              )}
            </span>
          </nav>

          <main className="content">
            <ChartTable rows={rows} style={tab} />
          </main>
        </>
      )}
    </div>
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
