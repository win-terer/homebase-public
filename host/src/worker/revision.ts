/**
 * 데이터 버전(rev) — 바뀐 게 없으면 다시 만들지 않기 위한 꼬리표.
 *
 * ## 왜 필요한가
 *
 * 달력을 처음 열면 표 전체를 훑는 조회가 셋 돈다(가맹점 이름 묶기·메모 사용 이력·정기결제 탐지).
 * 7,000건 기준 **71,319행 · 201ms**. 그다음부터는 422행 · 10ms 인데, 그 차이를 메우던 것이
 * isolate 메모리 캐시(10분)였다.
 *
 * 문제는 **그 캐시가 isolate 와 함께 죽는다**는 것이다. 혼자 쓰는 가계부라 접속 간격이 길고,
 * Workers 는 한가하면 isolate 를 금방 버린다 — 실전에서는 거의 매번 차가운 상태로 들어가
 * 매번 7만 행을 다시 읽었다.
 *
 * rev 는 **D1 에 있으므로 isolate 가 죽어도 살아남는다.** 바뀐 게 없으면 1행만 읽고 304 로
 * 끝내서, 세 번의 전체 훑기를 아예 시작하지 않는다.
 *
 * ## 어떻게 올리나 — 쓰기 경로를 손대지 않는다
 *
 * 쓰기 11곳에서 손으로 올리게 하면 한 곳만 빠뜨려도 그 변경이 화면에 **영영 반영되지 않는다**
 * (느린 것보다 나쁜 고장이다). 대신 모든 쿼리가 지나는 `countReads` 래퍼가 이미 센 `rowsWritten`
 * 을 보고, 요청이 끝날 때 **한 번만** 올린다. 새 기능을 추가해도 저절로 걸린다.
 */
import type { SqlDb } from "@homebase/db";

const KEY = "data.rev";

/** 지금 버전. 없으면 "0" — 첫 요청이라도 꼬리표는 붙는다. */
export async function readRev(db: SqlDb): Promise<string> {
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = ?").bind(KEY).first<{ value: string }>();
  return row?.value ?? "0";
}

/**
 * 버전을 1 올린다. 요청당 한 번만 부른다(쿼리마다가 아니라) — 2,244건 가져오기를 해도
 * 조각 수만큼만 쓴다. D1 무료 쓰기 한도(하루 10만)를 생각하면 이 차이가 크다.
 */
export async function bumpRev(db: SqlDb): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, '1')
       ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    )
    .bind(KEY)
    .run();
}

/** 서울 기준 오늘(YYYY-MM-DD). 날짜가 바뀌면 답도 바뀌는 조회가 있다(정기 결제의 '다음 예상일'). */
export function seoulDay(at = Date.now()): string {
  return new Date(at + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 캐시 판정에 쓰는 데이터 버전 = rev + 서울 날짜.
 *
 * rev 만 쓰면 **날이 바뀌어도 같은 답을 돌려준다.** 정기 결제의 '다음 예상일·안 나감' 처럼
 * 오늘이 며칠이냐로 달라지는 값이 어제 것으로 굳는다(데이터는 그대로이므로 rev 는 안 오른다).
 * 날짜를 섞으면 자정에 한 번만 다시 만든다.
 */
export function dataVersion(rev: string, at = Date.now()): string {
  return `${rev}.${seoulDay(at)}`;
}
