# INFOhSorry 설계 요약

INF는 INFINITAS 메모리 판독 결과와 플레이 기록을 수집해 로컬 프로필 및 연동 서비스에 제공하는 Electron 앱이다. 상세 구조와 데이터 흐름은 기존 문서를 기준으로 한다.

- [아키텍처](architecture.md)
- [데이터 흐름](data-flow.md)
- [플레이 기록 및 상세 판정](play-logger.md) — [12장 플레이 상세](play-logger.md#12-플레이-상세-등급별-fastslow--레인별-판정--plays_detailjsonl)
- [문서 목차](README.md)
- [변경 이력](../CHANGELOG.md)

## 플레이 상세 설계

상세 판정은 기존 플레이 기록의 `timestamp`와 정확히 대응하는 선택 데이터다. 형식은 `PlayDetail = {v:1,timestamp,complete,samples,dt_ms,p1,p2}`이며, 각 쪽은 등급별 FAST/SLOW, 8개 레인 판정, 레인별 FAST/SLOW와 각각의 확정 품질 정보를 담는다. 불완전하거나 미확정인 값은 0으로 대체하지 않으며, `complete:false`일 때 FAST/SLOW 값은 null일 수 있다. 레인 인덱스는 0–7로만 취급한다.

업로드 계약은 기존 `PUT /api/me/plays` 및 R2 `plays/{id}.json`을 유지한다. 형식 버전은 1, 최대 100행, 최대 본문 크기는 262144바이트다. DB·웹훅·dump·R2 키 계약은 바꾸지 않는다. 세부 필드 설명과 수집 한계는 [play-logger.md 12장](play-logger.md#12-플레이-상세-등급별-fastslow--레인별-판정--plays_detailjsonl)을 참조한다.
