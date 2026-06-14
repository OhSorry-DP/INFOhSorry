# INFOhSorry 상세 개발 문서

> INF오소리(INFINITAS 메모리 리딩 기반 DP 뷰어 Electron 앱)의 **내부 동작**을 함수/모듈/IPC/메모리 구조 단위로 깊게 다루는 개발자용 문서 모음입니다.

이 폴더(`docs/`)는 "이 프로젝트 내부가 어떻게 동작하는가" 에 집중합니다.
"이 프로젝트가 무엇이고 다른 오소리 프로젝트와 어떻게 엮이는가" 는 상위 조망 문서를 보세요.

- **상위 조망 문서**: [`../../docs/INFOhSorry.md`](../../docs/INFOhSorry.md) — INF오소리 개요 + 연관 프로젝트 + 공유 인프라(Gist/Supabase)
- **오소리 생태계 인덱스**: [`../../docs/README.md`](../../docs/README.md) — 전체 프로젝트 관계도
- **변경 이력(정본)**: 이 repo 의 [`../CHANGELOG.md`](../CHANGELOG.md)

---

## 문서 인덱스

| 문서 | 범위 |
|------|------|
| [architecture.md](architecture.md) | Electron main/preload/renderer 3 프로세스 구조, electron-vite 빌드, 앱 부팅 시퀀스, 5개 탭 구성, IPC 핸들러 등록 메커니즘 |
| [memory-reading.md](memory-reading.md) | Reflux 자동 다운로드/관리, `tracker.tsv` 파싱, koffi Win32 메모리 스캔(`memory.ts`), `profileOffsets`/`useProfile`, gist `offsets.json` 원격 갱신, INFINITAS 패치 시 offset 깨짐 대응 |
| [data-flow.md](data-flow.md) | 외부 데이터 소스(ereter/zasa/rating/spTier) gist 캐시 + TTL, `recommendCore` 의 gist 코어 통합, tsv 실시간 reload + Supabase 업로드(3분 주기) 분리, http-server LAN 원격제어(SSE), IIDX ID 전환 가드 |
| [ipc-reference.md](ipc-reference.md) | main↔renderer IPC 채널 전수 목록 + 각 핸들러 시그니처/역할, preload `window.infohsorry` API 매핑, HTTP `/api/ipc` bridge |
| [sp.md](sp.md) | **SP(싱글) 데이터 흐름** — Reflux 메모리 SP 5 slot → ① Supabase `play_style:0` 적재(SP10~12, 3분 주기), ② 원격모드 `/api/me` `sp_charts_json`+`sp_tier12` 실시간(SSE·setUser dedup·/osr 네트워크우선) |

---

## 빠른 참조

- **버전**: `0.0.75` (`package.json`)
- **스택**: Electron 28 + React 18 + TypeScript 5.4, 빌드 `electron-vite 3`, 패키징 `electron-builder`(NSIS + portable)
- **소스 트리**:
  - `src/main/` — Electron 메인 프로세스(Node 백엔드): IPC 핸들러, Reflux 관리, 메모리 스캔, 외부 데이터 fetch, LAN 서버
  - `src/preload/` — `contextBridge` 로 `window.infohsorry` 노출
  - `src/renderer/src/` — React UI(5개 탭) + Supabase 동기화 + gist 코어 통합
  - `src/shared/` — main/renderer 공유 타입(`types.ts`), 곡명 정규화(`match.ts`), 추천 보조(`recommend.ts`), 메모리 offset 상수(`profileOffsets.ts`)

> 본문 코드 인용은 모두 `파일경로:라인` 형식입니다(예: `src/main/index.ts:38`). 라인 번호는 작성 시점(v0.0.75) 기준이며 이후 변경될 수 있으니 함수명/심볼로 교차 확인하세요.
