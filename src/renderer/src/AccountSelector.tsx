// 저장된 IIDX 계정에서 볼 계정을 선택하는 오프라인/라이브 전환 셀렉터
import { useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { AccountMeta } from '../../shared/account';

interface AccountSelectorProps {
  accounts: AccountMeta[];
  selectedId: string | null;
  liveId: string | null;
  onSelect: (iidxId: string) => void;
}

const formatId = (raw: string): string =>
  /^[A-Z]\d{12}$/.test(raw)
    ? raw[0] + '-' + raw.slice(1, 5) + '-' + raw.slice(5, 9) + '-' + raw.slice(9, 13)
    : raw;

const relativeTime = (ms: number): string => {
  if (ms === 0) return '기록 없음';
  const now = Date.now();
  const diff = now - ms;
  if (diff < 0) return '방금 전';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '방금 전';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

const styles: {
  wrapper: CSSProperties;
  liveRow: CSSProperties;
  liveId: CSSProperties;
  liveBadge: CSSProperties;
  btn: CSSProperties;
  btnSelected: CSSProperties;
  btnPlaceholder: CSSProperties;
  caret: CSSProperties;
  list: CSSProperties;
  item: CSSProperties;
  itemActive: CSSProperties;
  itemTop: CSSProperties;
  itemTopActive: CSSProperties;
  itemBottom: CSSProperties;
} = {
  wrapper: {
    position: 'relative',
    display: 'inline-block',
    minWidth: 220,
  },
  liveRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 12px',
    background: 'var(--card-bg, #1e1e28)',
    border: '1px solid var(--border, #333)',
    borderRadius: 6,
    color: 'var(--text, #eee)',
    fontFamily: 'inherit',
    fontSize: 14,
  },
  liveId: {
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: 0.5,
  },
  liveBadge: {
    marginLeft: 'auto',
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1,
    color: '#0b120b',
    background: '#3fb950',
    borderRadius: 4,
  },
  btn: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    padding: '8px 12px',
    background: 'var(--card-bg, #1e1e28)',
    border: '1px solid var(--border, #333)',
    borderRadius: 6,
    color: 'var(--text, #eee)',
    fontFamily: 'inherit',
    fontSize: 14,
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  btnSelected: {
    border: '1px solid var(--accent, #6ea8fe)',
  },
  btnPlaceholder: {
    color: 'var(--text, #aaa)',
    opacity: 0.8,
  },
  caret: {
    fontSize: 10,
    opacity: 0.8,
  },
  list: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    width: '100%',
    zIndex: 50,
    maxHeight: 320,
    overflowY: 'auto',
    background: 'var(--card-bg, #1e1e28)',
    border: '1px solid var(--border, #333)',
    borderRadius: 6,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  item: {
    padding: '8px 12px',
    cursor: 'pointer',
    borderBottom: '1px solid var(--border, #2a2a35)',
  },
  itemActive: {
    background: 'rgba(110, 168, 254, 0.12)',
  },
  itemTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    color: 'var(--text, #eee)',
    fontSize: 14,
    fontVariantNumeric: 'tabular-nums',
  },
  itemTopActive: {
    fontWeight: 700,
    color: 'var(--accent, #6ea8fe)',
  },
  itemBottom: {
    marginTop: 2,
    color: 'var(--text, #888)',
    fontSize: 12,
    opacity: 0.85,
  },
};

export default function AccountSelector(props: AccountSelectorProps): JSX.Element | null {
  const { accounts, selectedId, liveId, onSelect } = props;
  const [open, setOpen] = useState<boolean>(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (accounts.length === 0 && !liveId) {
    return null;
  }

  if (liveId != null) {
    return (
      <div ref={rootRef} style={styles.wrapper}>
        <div style={styles.liveRow}>
          <span style={styles.liveId}>{formatId(liveId)}</span>
          <span style={styles.liveBadge}>LIVE</span>
        </div>
      </div>
    );
  }

  const hasSelected = selectedId != null;

  return (
    <div ref={rootRef} style={styles.wrapper}>
      <button
        type="button"
        style={{
          ...styles.btn,
          ...(hasSelected ? styles.btnSelected : styles.btnPlaceholder),
        }}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={styles.liveId}>
          {hasSelected ? formatId(selectedId as string) : '계정 선택'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ opacity: 0.85, fontSize: 12 }}>저장된 기록</span>
          <span style={styles.caret}>{open ? '▲' : '▼'}</span>
        </span>
      </button>

      {open && (
        <div style={styles.list} role="listbox">
          {accounts.map((acc) => {
            const active = acc.iidxId === selectedId;
            return (
              <div
                key={acc.iidxId}
                role="option"
                aria-selected={active}
                style={{
                  ...styles.item,
                  ...(active ? styles.itemActive : null),
                }}
                onClick={() => {
                  onSelect(acc.iidxId);
                  setOpen(false);
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'rgba(110,168,254,0.08)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = active
                    ? 'rgba(110,168,254,0.12)'
                    : 'transparent';
                }}
              >
                <div style={{ ...styles.itemTop, ...(active ? styles.itemTopActive : null) }}>
                  <span>{formatId(acc.iidxId)}</span>
                  {active && <span style={{ fontSize: 11, opacity: 0.9 }}>✓</span>}
                </div>
                <div style={styles.itemBottom}>
                  {acc.djName ?? '(DJ NAME 없음)'} · {relativeTime(acc.lastUpdatedAt)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
