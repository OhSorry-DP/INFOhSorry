# OpenWebUI — OhSorry DP Coach

집에서 혼자 쓰는 IIDX DP 코치 챗봇. OpenWebUI + 로컬 INF 앱(`ohsorry.local`)을 연결한다.

## 구조

```
OpenWebUI (LLM + Tools)
   │  GET  ohsorry.local:3000/api/me         ← 프로필(별값·레이더·차트)
   │  POST ohsorry.local:3000/api/recommend  ← { kind, params }
   ▼
INF 앱 main process
   └─ webContents.send('recommend:request') → renderer recCtx (코어 recommend.js)
        ├─ buildRecs         (클리어 추천)
        ├─ buildWeaknessRecs (연습곡)
        ├─ buildEstLadder    (추천곡 v3 사다리)
        └─ emodeTargets.ts   (E모드 등급 목표 폴더 A/AA/AAA/MAX−)
```

추천 알고리즘은 웹 iidx.in 이 쓰는 코어 `recommend.js` 와 동일하다. LLM 은 파라미터 선택 + 결과 언어화만 한다.

## 설치

1. **INF 앱을 실행**한다. HTTP 서버(`:3000`)는 dev(`npm run dev`)에서는 안 뜨고, `npm run build && npm run start` 또는 release 설치본에서 뜬다. 창을 열어두고 데이터 로딩이 끝날 때까지 기다린다.
2. OpenWebUI → **Workspace → Tools → `+`** → `ohsorry_coach.py` 내용 붙여넣기 → 저장.
   - `requests` 가 필요하다(파일 상단 `requirements`). OpenWebUI 가 자동 설치.
3. Tool 의 **Valves** 에서 `base_url` 확인. `http://ohsorry.local:3000` 이 기본. mDNS 가 안 되면 `http://<PC-IP>:3000`.
4. OpenWebUI → **Workspace → Models** 에서 모델 하나 만들고:
   - System Prompt = `system-prompt.md` 내용
   - Tools = `OhSorry DP Coach` 체크
5. 그 모델로 채팅.

## 엔드포인트 직접 호출 (디버그)

```bash
curl http://ohsorry.local:3000/api/me
curl -X POST http://ohsorry.local:3000/api/recommend -H 'content-type: application/json' \
  -d '{"kind":"meta"}'
curl -X POST http://ohsorry.local:3000/api/recommend -H 'content-type: application/json' \
  -d '{"kind":"practice","params":{"feature":"TRILL","strength":2}}'
curl -X POST http://ohsorry.local:3000/api/recommend -H 'content-type: application/json' \
  -d '{"kind":"targets","params":{"grade":"aa"}}'
```

`503` = INF 창이 없거나 추천 lib 로딩 중. 잠시 후 재시도.

## 나중에 (CF AI 워커)

웹 배포는 OpenWebUI 가 아니라 Cloudflare AI 워커로 별도 재구축 예정. 지금 구조와 무관 — 이건 로컬 개인용.
