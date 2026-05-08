import { useEffect, useMemo, useState } from 'react';
import type { SongRow } from '../../shared/types';
import ChartTable from './ChartTable';

const STORAGE_KEY = 'infohsorry_tsv_path';

type Tab = 'sp' | 'dp';

export default function App() {
  const [tsvPath, setTsvPath] = useState<string | null>(null);
  const [rows, setRows] = useState<SongRow[]>([]);
  const [tab, setTab] = useState<Tab>('sp');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 마운트 시 마지막으로 사용한 TSV 경로 복원
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setTsvPath(saved);
      void loadTsv(saved);
    }
  }, []);

  async function loadTsv(path: string) {
    setLoading(true);
    setError(null);
    try {
      const r = await window.infohsorry.readTsv(path);
      if (!r.ok) {
        setError(r.error || '읽기 실패');
        setRows([]);
      } else {
        setRows(r.rows || []);
      }
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function pickAndLoad() {
    const picked = await window.infohsorry.pickTsv();
    if (!picked) return;
    localStorage.setItem(STORAGE_KEY, picked);
    setTsvPath(picked);
    await loadTsv(picked);
  }

  // 통계: 각 탭에서 unlock 된 곡 수 / 플레이한 곡 수
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
          <span className="subtitle">IIDX INFINITAS · Reflux TSV viewer</span>
        </div>
        <div className="actions">
          <button onClick={pickAndLoad} disabled={loading}>
            {tsvPath ? 'TSV 다시 선택' : 'TSV 파일 선택'}
          </button>
          {tsvPath && (
            <button onClick={() => loadTsv(tsvPath)} disabled={loading} title="새로고침">
              ↻
            </button>
          )}
        </div>
      </header>

      {tsvPath && (
        <div className="path-bar" title={tsvPath}>
          {tsvPath}
        </div>
      )}

      {error && <div className="error">에러: {error}</div>}

      {!tsvPath && !loading && !error && (
        <div className="empty-state">
          <p>Reflux 가 출력한 TSV 파일을 선택하세요.</p>
          <p className="hint">
            Reflux 폴더의 <code>tracker_data.tsv</code> 같은 파일이 일반적입니다 (Reflux config 에서
            정한 이름).
          </p>
        </div>
      )}

      {tsvPath && !loading && rows.length > 0 && (
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
            </span>
          </nav>

          <main className="content">
            <ChartTable rows={rows} style={tab} />
          </main>
        </>
      )}

      {tsvPath && !loading && rows.length === 0 && !error && (
        <div className="empty-state">
          <p>파싱된 곡이 0 개입니다. TSV 형식이 다른지 확인해주세요.</p>
        </div>
      )}

      {loading && <div className="loading">불러오는 중...</div>}
    </div>
  );
}
