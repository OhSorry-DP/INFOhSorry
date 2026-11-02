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

## 레인 배치와 표시

플레이 CSV는 22열 뒤에 `lane_order_p1`·`lane_order_p2`를 추가한 24열이며, 옛 19·21·22열 행도 읽는다. INF PLAY LOG와 웹 Play Log는 스코어·판정·랜덤 레인 패턴·레인별 평가를 세로로 표시하고 건반 하나의 상세를 마우스·탭·포커스로 연다. 배치 방향과 건반 인덱스 대응은 실기 확인 전 가정이다. 저장·표시 계약과 한계는 [play-logger.md 6장](play-logger.md#6-csv-열) 및 [13장](play-logger.md#13-레인-배치와-레인별-평가-2026-11-03)을 따른다.

웹 PUT은 새 필드를 수용하고 코치 `getPlays`는 두 필드를 제외해 응답·OpenAPI·Knowledge를 유지한다. 웹을 먼저 배포한 뒤 INF를 릴리스한다.
