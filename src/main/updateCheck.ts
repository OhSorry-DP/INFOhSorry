// GitHub Releases API 로 최신 버전 체크 + 현재 버전 과 비교.
// 알림 전용 (electron-updater 같은 자동 다운로드 X) — 사용자가 클릭해서 GitHub 릴리즈 페이지 가서 수동 다운로드.
import { app } from 'electron';
// UpdateInfo 는 shared/types.ts 가 단일 정의 — renderer / preload 와 같은 타입 사용 (중복 정의 방지).
import type { UpdateInfo } from '../shared/types';

export type { UpdateInfo };

const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/OhSorry-DP/INFOhSorry/releases/latest';

// "0.0.16" 같은 SemVer 비교. v 접두사 제거 후 dot split + 숫자 비교.
// a > b 면 양수, a < b 면 음수, 같으면 0.
function compareVersion(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/i, '').split('.').map((s) => parseInt(s, 10) || 0);
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion();
  try {
    const res = await fetch(GITHUB_LATEST_RELEASE_URL, {
      headers: {
        'User-Agent': 'INFOhSorry (+https://github.com/OhSorry-DP/INFOhSorry)',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) {
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: null,
        htmlUrl: null,
        publishedAt: null,
        portableUrl: null,
        portableName: null,
        portableSize: null,
        error: `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      published_at?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: Array<{ name: string; browser_download_url: string; size: number }>;
    };
    if (json.draft || json.prerelease) {
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: null,
        htmlUrl: null,
        publishedAt: null,
        portableUrl: null,
        portableName: null,
        portableSize: null,
      };
    }
    const latestVersion = (json.tag_name || '').replace(/^v/i, '');
    if (!latestVersion) {
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: null,
        htmlUrl: null,
        publishedAt: null,
        portableUrl: null,
        portableName: null,
        portableSize: null,
        error: 'tag_name 없음',
      };
    }
    // assets 에서 portable .exe 추출 (예: ohSorryScoreINF-0.0.19-portable.exe)
    const portableAsset = json.assets?.find((a) => /portable.*\.exe$/i.test(a.name));
    const hasUpdate = compareVersion(latestVersion, currentVersion) > 0;
    return {
      hasUpdate,
      currentVersion,
      latestVersion,
      htmlUrl: json.html_url ?? null,
      publishedAt: json.published_at ?? null,
      portableUrl: portableAsset?.browser_download_url ?? null,
      portableName: portableAsset?.name ?? null,
      portableSize: portableAsset?.size ?? null,
    };
  } catch (e) {
    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: null,
      htmlUrl: null,
      publishedAt: null,
      portableUrl: null,
      portableName: null,
      portableSize: null,
      error: (e as Error).message,
    };
  }
}
