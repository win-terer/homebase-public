/**
 * 비싼 계산을 **데이터 버전과 함께** D1 에 저장해 두고, 버전이 같으면 다시 하지 않는다.
 *
 * ## 왜 메모리 캐시로는 부족한가
 *
 * 가맹점 이름 묶기·메모 사용 이력·정기 결제는 표 전체를 훑는다(7,000건 기준 합쳐서 7만 행·201ms).
 * 그래서 인스턴스 메모리에 10분 캐시를 두고 있었는데, **그 캐시는 isolate 와 함께 죽는다.**
 * 혼자 쓰는 앱이라 접속 간격이 길고 Workers 는 한가하면 isolate 를 버린다 — 실전에선 거의
 * 매번 차가운 채로 7만 행을 다시 읽었다.
 *
 * ETag(`host/src/worker/revision.ts`)가 **안 바뀐 경우**는 이미 막아 준다(304, 핸들러를 안 돌림).
 * 여기서 막는 건 그 나머지, **바뀐 뒤 첫 요청**이다. 사용자가 가계부를 수시로 올리므로
 * 그 "첫 요청" 이 자주 온다.
 *
 * ## 어떻게
 *
 * `app_meta` 에 `{rev, data}` 를 JSON 으로 둔다. 읽을 때 지금 rev 와 같으면 그대로 쓴다(2행).
 * 다르면 다시 계산해서 덮는다. **GET 에서 이 쓰기가 일어나도 데이터 버전은 안 오른다** —
 * 버전은 POST/PUT/PATCH/DELETE 에서만 오르기 때문(`app.ts`). 그래서 캐시를 채우는 행위가
 * 스스로 캐시를 무효로 만드는 일이 없다.
 *
 * 메모리 캐시는 그대로 둔다 — 같은 isolate 안에서 연달아 부를 때는 그게 제일 싸다.
 * 여기는 그 뒤를 받치는 두 번째 층이다.
 */
import type { SqlDb } from "@homebase/db";

const REV_KEY = "data.rev";

/** 지금 데이터 버전. 캐시가 아직 쓸 만한지 판단하는 기준 하나뿐이라 1행이면 된다. */
async function currentRev(db: SqlDb): Promise<string> {
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = ?").bind(REV_KEY).first<{ value: string }>();
  return row?.value ?? "0";
}

/**
 * `name` 으로 저장해 둔 계산 결과를 돌려준다. 데이터가 바뀌었으면 `compute()` 로 다시 만든다.
 *
 * 저장이 실패해도(한도·용량) 계산 결과는 그대로 돌려준다 — 캐시는 빠르자고 두는 것이지
 * 없다고 화면이 멈출 일은 아니다.
 */
export async function revCached<T>(db: SqlDb, name: string, compute: () => Promise<T>): Promise<T> {
  const key = `cache.${name}`;
  const rev = await currentRev(db);
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = ?").bind(key).first<{ value: string }>();
  if (row?.value) {
    try {
      const saved = JSON.parse(row.value) as { rev: string; data: T };
      if (saved.rev === rev) return saved.data;
    } catch {
      // 저장해 둔 게 깨졌으면 그냥 다시 만든다
    }
  }
  const data = await compute();
  try {
    await db
      .prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(key, JSON.stringify({ rev, data }))
      .run();
  } catch (e) {
    console.warn(`캐시 저장 실패(${name}) — 계산 결과는 그대로 씁니다: ${e}`);
  }
  return data;
}
