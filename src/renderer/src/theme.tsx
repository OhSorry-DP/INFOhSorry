// 다크모드 — light / dark 2단계 토글. 기본은 다크.
// `<html data-theme="light|dark">` 로 적용.
// CSS 변수 (index.css :root + [data-theme="dark"]) 가 자동 전환 처리.
import { useEffect, useState } from 'react';
import { IS_BROWSER_REMOTE } from './api';

export type ThemeMode = 'light' | 'dark';
const STORAGE_KEY = 'infohsorry-theme';

function loadStoredTheme(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : 'dark';
}

export function useTheme(): { mode: ThemeMode; toggle: () => void } {
  const [mode, setMode] = useState<ThemeMode>(loadStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  const toggle = (): void => {
    const next: ThemeMode = mode === 'light' ? 'dark' : 'light';
    setMode(next);
    localStorage.setItem(STORAGE_KEY, next);
  };

  return { mode, toggle };
}

const ICON: Record<ThemeMode, string> = { light: '☀', dark: '🌙' };
const TITLE: Record<ThemeMode, string> = {
  light: '라이트 모드 — 클릭해서 다크',
  dark: '다크 모드 — 클릭해서 라이트',
};

export function ThemeToggle(): JSX.Element {
  const { mode, toggle } = useTheme();
  return (
    <button type="button" className="theme-toggle" onClick={toggle} title={TITLE[mode]}>
      {ICON[mode]}
    </button>
  );
}

// 프레임리스 모드 — 창 최소화 / 최대화 / 닫기 버튼.
// 호스트 (Electron) 환경에서만 표시 — 브라우저 원격 (PC2) 에서는 의미 없으니 숨김.
export function WindowControls(): JSX.Element | null {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (IS_BROWSER_REMOTE) return;
    void window.infohsorry.window.isMaximized().then(setMaximized);
    return window.infohsorry.window.onMaximizedChange(setMaximized);
  }, []);

  if (IS_BROWSER_REMOTE) return null;

  return (
    <div className="window-controls">
      <button
        type="button"
        className="wc-btn wc-min"
        onClick={() => void window.infohsorry.window.minimize()}
        title="최소화"
        aria-label="최소화"
      >
        {/* 가로 막대 — fill 을 currentColor 로 해서 테마 따라가게 */}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className="wc-btn wc-max"
        onClick={() => void window.infohsorry.window.maximizeToggle()}
        title={maximized ? '복원' : '최대화'}
        aria-label={maximized ? '복원' : '최대화'}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          {maximized ? (
            // 두 개의 사각형 (restore 아이콘)
            <>
              <rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="3.5" y="0.5" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" />
            </>
          ) : (
            <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
          )}
        </svg>
      </button>
      <button
        type="button"
        className="wc-btn wc-close"
        onClick={() => void window.infohsorry.window.close()}
        title="닫기"
        aria-label="닫기"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1" />
          <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
