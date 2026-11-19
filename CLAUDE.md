# 고치기 전에 읽을 것

homebase 를 고치려는 사람(과 AI)을 위한 안내다. **혼자 쓰는 앱**이라는 전제가 설계 곳곳에 박혀
있으니, 그 전제를 모르고 손대면 엉뚱한 데서 깨진다.

## 구조

TypeScript · pnpm workspaces · Cloudflare Workers + D1(SQLite) · Hono · React 19 + Vite +
React Router · Vitest(테스트 DB 는 better-sqlite3 어댑터).

```
host/src/worker  워커 입구: 로그인(auth.ts) → /api/<앱> → 화면 파일
host/src/web     SPA 셸
apps/calendar/   일정. src/shared/occurrences.ts = 반복·여러 날 펼치기(서버·화면 공용)
apps/ledger/     가계부 + 달력. src/importers = 파일 읽기(브라우저) + 기본 판단(서버)
shared/core      앱↔host 계약 (ServerModule), 사진, 브라우저 캐시, 비밀값 봉하기
shared/db        DB 계약 SqlDb(D1 모양) + 테스트용 better-sqlite3 어댑터
shared/ui        공통 레이아웃·디자인 토큰 (Pretendard 번들, 라이트/다크)
migrations/      D1 마이그레이션 (NNNN_<앱id>_이름.sql, 모든 앱 공용)
tools/ledger-sync 메일에서 엑셀을 받아 올리는 도구 (저장소 밖 컴퓨터에서 돈다)
```

앱을 더하려면 `apps/<id>` 를 만들고 `host/src/worker/app.ts` 와 `host/src/web/modules.ts` 에
등록한다. 테이블 이름은 `<id>_` 접두어, 마이그레이션은 루트 `migrations/` 에 둔다.

```bash
pnpm dev         # 빌드 + 로컬 D1 + wrangler dev :8787 (.dev.vars 에 LOGIN_PASSWORD)
                 # ↑ wrangler.jsonc 의 PHOTOS id 가 비어 있으면 설정을 거부한다 — 로컬은 아무 값이나 넣으면 된다
pnpm test        # 전부 가짜 데이터
pnpm typecheck
pnpm deploy      # Workers Builds 가 main 에서 실행한다 (배포 → 원격 마이그레이션 순서)
```

## D1 무료 한도를 지키는 법 — 가장 중요하다

하루 **읽기 500만 행 · 쓰기 10만 행**이고, **계정 전체 합산**이다. 넘기면 그날 하루 데이터베이스가
통째로 막힌다(앱이 아니라 계정이 막힌다).

실제로 한 번 넘긴 적이 있다. 카테고리 옮기기가 `(SELECT … FROM json_each(?) WHERE …)` 상관
서브쿼리로 **(건수)² 행**을 읽었고, 배포 직후 동시 요청마다 돌아 3,000만 행을 읽었다. 그래서
규칙이 생겼다.

1. **읽기 예산 테스트** (`apps/ledger/src/server/d1-budget.test.ts`) — 진짜 D1(로컬 workerd)에
   7,000건을 넣고 API 마다 `rows_read` 를 재서 상한을 넘으면 실패한다. 2,000건에서도 재서
   **건수에 비례해서만** 느는지(제곱이 아닌지) 확인한다. **새 쿼리·API 는 여기에 추가**하고
   통과한 뒤에만 머지한다. 같은 파일의 소스 검사가 상관 서브쿼리 모양 자체를 막는다
2. 행마다 JSON 을 다시 훑는 상관 서브쿼리 금지 → 기본 키가 있는 임시 표(`ledger_scratch`)에 넣고
   키로 찾는다. 기록마다 작은 표를 조인하지 말고 따로 읽어 JS 에서 맞춘다(조인하면 행당 3~4배)
3. 전체를 훑는 조회는 캐시하거나 부분 인덱스를 쓴다. **인덱스를 더하면 다른 쿼리의 계획이 바뀔 수
   있다** — 예산 테스트로 확인한다
4. 한 번만 돌아야 하는 작업은 `app_meta` compare-and-swap 으로 한 요청만 실행하고, 실패해도
   **최대 3번**까지만 다시 한다(한도에 걸려 실패하면 되돌리기도 막혀서 하루 종일 반복된다)
5. 운영 안전장치: 요청마다 읽기를 세어 15만 행을 넘으면 나머지 쿼리를 막는다(503)

## 캐시 3층 — 각각 무엇을 막는가

거점이 멀면 왕복 한 번이 수백 ms 다. **쿼리를 더 깎는 것보다 왕복을 줄이는 게 이득이 크다.**

1. **브라우저 캐시**(`shared/core/src/web-cache.ts`) — 시작할 때 `/api/rev` 로 버전 하나만 묻고,
   들고 있던 응답이 같은 버전이면 네트워크를 아예 안 탄다
2. **ETag/304**(`host/src/worker/app.ts`) — 꼬리표가 같으면 핸들러를 돌리지 않는다
3. **rev-cache**(`apps/ledger/src/server/rev-cache.ts`) — 데이터가 **바뀐 뒤 첫 요청**을 막는다.
   전체 훑기 결과를 `{rev, data}` 로 D1 에 저장해 둔다(isolate 가 죽어도 남는 게 메모리 캐시와 다르다)

데이터 버전은 `rev` + 서울 날짜다. 날짜를 섞는 이유는 '다음 예상 결제일' 처럼 **데이터는 그대로인데
오늘이 며칠이냐로 답이 달라지는** 것이 있어서다.

**GET 은 버전을 올리지 않는다.** 읽기에도 살림 쓰기가 섞이는데(세션 연장 등) 그걸 데이터 변경으로
치면 꼬리표가 혼자 바뀌어 캐시가 매번 깨진다.

## 보안 모델

- **혼자 쓴다.** 사용자 표가 없고, 비밀번호 하나 + OTP 하나다. 남과 같이 쓰려면 구조를 바꿔야 한다
- 비밀번호는 워커 Secret `LOGIN_PASSWORD`, OTP 비밀은 첫 `/setup` 에서 만들어 D1 에 저장.
  세션 쿠키는 무작위 토큰이고 **D1 에는 해시만** 둔다
- **키로 열리는 경로는 못 박아 둔다**(`auth.ts` 의 `IMPORT_PATHS`·`NOTIFY_PATHS`). 키 하나가
  새도 거기까지만 열리게. **이 범위를 넓히지 말 것** — 넓히려는 이유가 생기면 보통 설계가 틀린 것이다
  (메일 설정을 도구에 넘길 때도 키 범위 대신 일회용 코드를 새로 만들었다)
- 설정에 섞이는 비밀값은 `SETTINGS_KEY` 로 봉해서 저장한다(`shared/core/src/secrets.ts`).
  **열쇠가 없으면 저장을 거절한다** — 평문으로 두느니 기능을 끈다
- 테스트와 커밋에 **실제 금액·상호·개인 정보를 넣지 않는다**

## 자주 밟는 함정

- **한글 입력**: Enter 로 저장하거나 blur 할 때 `e.nativeEvent.isComposing` 이면 무시한다.
  안 그러면 조합 중인 마지막 글자가 두 번 들어간다(`라프텔텔`)
- **달력 안에서 `position: fixed`**: 달력이 `container-type: inline-size` 라 기준이 어긋난다.
  팝업·설명 상자는 `document.body` 에 portal 로 그린다
- **flex 로 만든 도구줄이 자꾸 두 줄로 내려감**: 줄어들 수 있는 항목(`flex: 0 1 220px` +
  `min-width`)은 컨테이너 폭 계산에 `min-width` 가, 그리기에는 `basis` 가 쓰여 **항상 넘친다**.
  고정 폭으로 두면 해결된다
- **백그라운드 프로세스를 `pkill -f` 로 끄지 말 것** — 같은 문자열이 든 자기 셸까지 죽는다.
  PID 를 저장해 두고 그 PID 로 끈다
- **화면에서만 묶는 것들**: 쪼개져 들어온 결제(`split-pay.ts`)와 취소 짝(`pairCancels`)은 DB 를
  건드리지 않고 화면에서 묶는다. 소스가 다시 그 모양으로 주기 때문이다. 묶는 순서는
  `mergeSplits` → `pairCancels` (합쳐 두면 쪼개져 들어온 환불도 금액이 맞아 저절로 묶인다)
- **알림 파서는 모르면 `null`**(`notify-parse.ts`). 광고·잔액 안내가 훨씬 많아서, 틀린 거래가
  들어가는 게 빈 화면보다 나쁘다

## 한국 전용인 부분

- 카드 내역은 **뱅크샐러드 내보내기**가 기본이다(`apps/ledger/src/importers/`). 형식이 바뀌면
  거기만 고치면 된다
- 공휴일은 `@hyunbinseo/holidays-kr`(오프라인). **해마다 패키지를 올려야** 새해 공휴일이 맞는다
- 연말정산 카드 공제·예상 환급(`apps/ledger/src/web/tax.ts`)은 한국 세법 기준이다. 요율은 해마다 바뀐다
- 현금영수증은 홈택스 CSV 를 읽는다. **홈택스 누계 파일에는 주민등록번호가 있으니 읽지도 저장하지도 않는다**
- 시간대는 `Asia/Seoul` 고정

다른 나라에서 쓰려면 가져오기(`importers/`)와 공휴일, 연말정산을 갈아 끼우면 된다. 나머지(달력·
메모·태그·정기 결제·통계)는 나라를 타지 않는다.
