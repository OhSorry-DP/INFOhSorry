import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { resolve } from 'path';
import pkg from './package.json';

// electron-vite 가 main / preload / renderer 세 개를 각각 빌드함
// memoryjs 같은 native 모듈은 externalizeDepsPlugin 으로 번들 제외 (require 그대로)
//
// __APP_VERSION__: 렌더러에서 package.json 의 version 을 읽기 위한 define.
// (이전엔 App.tsx 에 하드코드 → 버전 bump 시 누락되어 supabase 에 옛 버전 올라가는 버그.)
// shared/normTitle.js 는 UMD(module.exports) 동기 사본 — Rollup 이 CJS→ESM 변환하도록
//   commonjsOptions.include 에 명시(기본은 node_modules 만 변환). match.ts 의 default import 가
//   이 변환에 의존. main(Node)·renderer(browser) 둘 다 match.ts 를 번들하므로 양쪽에 적용.
const NORMTITLE_CJS = {
  commonjsOptions: { include: [/normTitle\.js$/, /node_modules/], transformMixedEsModules: true },
};

// dev(serve) 전용 — 위 commonjsOptions 는 Rollup 빌드 전용이라 renderer 의 Vite dev 서버는 타지 않는다.
//   그 결과 dev 에서만 UMD 인 normTitle.js 가 변환 없이 ESM 으로 서빙되어 match.ts 의 default import 가
//   "does not provide an export named 'default'" 로 실패 → 렌더러 전체 백지.
//   CJS 껍데기(module.exports)를 씌워 UMD wrapper 의 Node 분기를 태우고 그 값을 default 로 재노출 —
//   빌드(commonjs 플러그인) 결과와 동일한 형태를 dev 에서 재현한다.
//   main 은 dev 에서도 Rollup 빌드를 거치므로 이 플러그인이 필요 없다(renderer 에만 적용).
const normTitleUmdDev: Plugin = {
  name: 'normtitle-umd-dev',
  apply: 'serve',
  transform(code, id) {
    // id 에 ?v=..., ?import 등 쿼리가 붙을 수 있어 경로부만 비교. Windows 역슬래시도 정규화.
    const path = id.split('?')[0].replace(/\\/g, '/');
    if (!path.endsWith('/src/shared/normTitle.js')) return null;
    return {
      code: `const module = { exports: {} };\n${code}\nexport default module.exports;\n`,
      map: null,
    };
  },
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: NORMTITLE_CJS,
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react(), normTitleUmdDev],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    build: NORMTITLE_CJS,
  },
});
