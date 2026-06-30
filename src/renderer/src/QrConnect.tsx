// QrConnect — 폰/다른 PC 를 같은 LAN 의 INF 서버로 연결하도록 QR + 주소 안내(호스트 전용).
//   server.info()(=main http-server connectInfo) 로 LAN IP/포트/ohsorry.local 을 받아 QR 생성.
//   QR = IP 기반 URL(가장 확실). ohsorry.local 은 타이핑용으로 병기(mDNS).
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';

interface Info {
  ip: string | null;
  port: number;
  port80: boolean;
  localName: string;
  url: string | null;
  nameUrl: string;
  qr: string | null;
}

export function QrConnect({ onClose }: { onClose: () => void }): JSX.Element {
  const [info, setInfo] = useState<Info | null | undefined>(undefined); // undefined=로딩

  useEffect(() => {
    let alive = true;
    window.infohsorry.server
      .info()
      .then((i) => { if (alive) setInfo((i as Info) ?? null); })
      .catch(() => { if (alive) setInfo(null); });
    return () => { alive = false; };
  }, []);
  const qr = info ? info.qr : null;

  const overlay: CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
  };
  const modal: CSSProperties = {
    position: 'relative', background: 'var(--card-bg,#1e1e28)', color: 'var(--text,#eee)',
    borderRadius: 12, padding: '24px 28px', maxWidth: 360, textAlign: 'center',
    boxShadow: '0 8px 32px rgba(0,0,0,.4)',
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onClose}
          aria-label="닫기"
          style={{ position: 'absolute', top: 8, right: 10, background: 'none', border: 'none', color: 'inherit', fontSize: 18, cursor: 'pointer' }}
        >
          ✕
        </button>
        <h2 style={{ margin: '0 0 14px', fontSize: 18 }}>📱 폰 / 다른 PC 로 연결</h2>

        {info === undefined && <p>불러오는 중…</p>}
        {info === null && (
          <p style={{ lineHeight: 1.6 }}>
            LAN 서버가 실행 중이 아닙니다.
            <br />
            <span style={{ opacity: 0.7, fontSize: 13 }}>(설치/포터블 빌드에서만 동작)</span>
          </p>
        )}
        {info && (
          <>
            {qr
              ? <img src={qr} alt="연결 QR" style={{ width: 240, height: 240, background: '#fff', borderRadius: 8, padding: 8 }} />
              : <p>QR 생성 중…</p>}
            <p style={{ margin: '12px 0 6px', fontSize: 13, opacity: 0.85 }}>같은 와이파이에서 카메라로 QR 스캔</p>
            <div style={{ fontSize: 13, lineHeight: 1.8, textAlign: 'left', marginTop: 8 }}>
              {info.url && (
                <div><b>주소</b> <code style={{ userSelect: 'all' }}>{info.url}</code></div>
              )}
              <div>
                <b>이름</b> <code style={{ userSelect: 'all' }}>{info.nameUrl}</code>
                {!info.port80 && <span style={{ opacity: 0.6 }}> (80포트 미사용)</span>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
