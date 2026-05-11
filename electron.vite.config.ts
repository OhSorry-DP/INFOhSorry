import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import pkg from './package.json';

// electron-vite 가 main / preload / renderer 세 개를 각각 빌드함
// memoryjs 같은 native 모듈은 externalizeDepsPlugin 으로 번들 제외 (require 그대로)
//
// __APP_VERSION__: 렌더러에서 package.json 의 version 을 읽기 위한 define.
// (이전엔 App.tsx 에 하드코드 → 버전 bump 시 누락되어 supabase 에 옛 버전 올라가는 버그.)
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
  },
});
