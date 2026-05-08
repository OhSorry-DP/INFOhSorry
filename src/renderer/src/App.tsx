import { useState } from 'react';

// 기본 PoC: INFINITAS 프로세스 핸들 잡기까지 검증
// 실제 메모리 읽기 (ex score, 곡 ID 등) 는 다음 단계에서 추가
const DEFAULT_EXE = 'bm2dx.exe';

export default function App() {
  const [exeName, setExeName] = useState(DEFAULT_EXE);
  const [result, setResult] = useState<string>('"탐색" 버튼을 누르면 메모리 핸들을 시도합니다.');
  const [loading, setLoading] = useState(false);

  const onProbe = async () => {
    setLoading(true);
    setResult('탐색 중...');
    try {
      const r = await window.infohsorry.probe(exeName);
      if (r.ok) {
        setResult(
          `OK\npid=${r.pid}\nmodName=${r.modName}\nmodBaseAddr=${r.modBaseAddr}\nmodBaseSize=${r.modBaseSize?.toLocaleString()}`,
        );
      } else {
        setResult(`실패: ${r.error}`);
      }
    } catch (e) {
      setResult(`예외: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ fontFamily: 'sans-serif', padding: 24, color: '#222' }}>
      <h1 style={{ margin: '0 0 4px' }}>INFOhSorry</h1>
      <p style={{ color: '#666', marginTop: 0 }}>IIDX INFINITAS 메모리 캡처 PoC</p>

      <div style={{ marginTop: 16 }}>
        <label style={{ display: 'block', fontSize: 12, color: '#555', marginBottom: 4 }}>
          실행 파일 이름
        </label>
        <input
          type="text"
          value={exeName}
          onChange={(e) => setExeName(e.target.value)}
          style={{
            width: 280,
            padding: '6px 8px',
            border: '1px solid #ccc',
            borderRadius: 4,
            fontSize: 13,
          }}
        />
        <button
          onClick={onProbe}
          disabled={loading || !exeName}
          style={{
            marginLeft: 8,
            padding: '6px 14px',
            fontSize: 13,
            cursor: loading ? 'wait' : 'pointer',
          }}
        >
          탐색
        </button>
      </div>

      <pre
        style={{
          marginTop: 16,
          padding: 12,
          background: '#f4f4f6',
          borderRadius: 4,
          fontSize: 12,
          whiteSpace: 'pre-wrap',
        }}
      >
        {result}
      </pre>
    </div>
  );
}
