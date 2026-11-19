import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { ledgerServer } from "./index.ts";

let db: SqliteDb;
let api: ReturnType<typeof ledgerServer.createApi>;
const call = (path: string, init?: RequestInit) => api.request(path, init, { DB: db });

beforeEach(() => {
  db = openMigratedSqlite();
  api = ledgerServer.createApi();
  const insert = db.raw.prepare(
    "INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, source) VALUES (?, ?, ?, ?, ?, ?, 'manual')",
  );
  insert.run("expense", "active", "2026-03-01", "12:00:00", "가짜식당", -40000);
  insert.run("expense", "active", "2026-03-01", null, "가짜관리비", -100000);
  insert.run("transfer", "review", "2026-03-02", "09:00:00", "가짜보험", -30000);
  insert.run("expense", "active", "2026-04-01", "10:00:00", "다음달", -1000);
});

describe("ledger api", () => {
  it("앱알림 줄의 분류를 고르면 가맹점 이름으로 기억하고, 비우면 잊는다", async () => {
    db.raw
      .prepare("INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, source, dedupe_key) VALUES ('expense','active','2026-03-03','10:00:00','가짜페이(주)',-5000,'notify','n1')")
      .run();
    // 카테고리는 API 로 만든다 — 첫 요청이 카테고리 판을 새로 짜서(ensureCategoryVersion) 미리 넣은 건 사라진다
    const patch = (body: { categoryId: number | null } | { newCategory: string }) =>
      call("/transactions/5", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const remembered = () => (db.raw.prepare("SELECT value FROM ledger_settings WHERE key = 'notify.category.가짜페이(주)'").get() as { value: string } | undefined)?.value;

    const res = await patch({ newCategory: "가짜분류" });
    expect(res.status).toBe(200);
    const { categoryId } = (await res.json()) as { categoryId: number };
    expect(remembered()).toBe(String(categoryId));
    await patch({ categoryId: null });
    expect(remembered()).toBeUndefined();
  });

  it("검색은 찾은 결제를 취소한 환불 줄도 같이 준다 (화면이 취소선을 긋게)", async () => {
    const hdr = { "Content-Type": "application/json" };
    // 같은 가게·같은 금액의 환불 — 메모가 없어 검색에는 안 걸린다
    db.raw
      .prepare("INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, source) VALUES ('expense','active','2026-03-02','10:00:00','가짜식당',40000,'manual')")
      .run();
    await call("/transactions/1", { method: "PATCH", headers: hdr, body: JSON.stringify({ memo: "취소한 저녁" }) });

    const r = (await (await call("/search?q=" + encodeURIComponent("취소한"))).json()) as { results: { id: number }[]; cancels: { id: number; amount: number }[] };
    expect(r.results.map((x) => x.id)).toEqual([1]); // 환불 줄은 결과에 안 넣는다
    expect(r.cancels.map((x) => x.amount)).toEqual([40000]); // 짝 맞출 재료로만 따로 준다
  });

  it("태그: 메모 낱말로 붙고, 검색·PATCH 응답에도 따라온다", async () => {
    const hdr = { "Content-Type": "application/json" };
    await call("/tags", { method: "POST", headers: hdr, body: JSON.stringify({ word: "몽이", tag: "반려동물" }) });
    await call("/transactions/1", { method: "PATCH", headers: hdr, body: JSON.stringify({ memo: "몽이 사료" }) });

    // 메모를 저장하면 태그가 같이 온다 (화면이 다시 안 받아도 되게)
    const saved = (await (await call("/transactions/2", { method: "PATCH", headers: hdr, body: JSON.stringify({ memo: "몽이 병원" }) })).json()) as { tags: string[] };
    expect(saved.tags).toEqual(["반려동물"]);

    // 목록에도 붙어 나온다. 분류는 **안 건드린다**
    const day = (await (await call("/transactions?from=2026-03-01&to=2026-03-01")).json()) as { id: number; tags?: string[]; categoryId: number | null }[];
    expect(day.find((t) => t.id === 1)).toMatchObject({ tags: ["반려동물"], categoryId: null });
    expect(day.find((t) => t.id === 4)?.tags).toBeUndefined();

    // '#태그' 로 찾기 — 태그만 본다
    const hit = (await (await call("/search?q=" + encodeURIComponent("#반려동물"))).json()) as { results: { id: number }[] };
    expect(hit.results.map((r) => r.id).sort()).toEqual([1, 2]);
    const none = (await (await call("/search?q=" + encodeURIComponent("#없는태그"))).json()) as { results: unknown[] };
    expect(none.results).toEqual([]);

    // 규칙을 지우면 흔적 없이 사라진다 (메모는 그대로)
    await call("/tags/" + encodeURIComponent("몽이"), { method: "DELETE" });
    const after = (await (await call("/transactions?from=2026-03-01&to=2026-03-01")).json()) as { id: number; tags?: string[]; memo: string | null }[];
    const back = after.find((t) => t.id === 1)!;
    expect(back).toMatchObject({ memo: "몽이 사료" });
    expect("tags" in back).toBe(false);
  });

  it("결제대행사 이름(네이버페이 등)으로는 분류를 기억하지 않는다", async () => {
    // 네이버페이·인터넷상거래 같은 이름은 가게가 아니라 '길목' 이다. 한 번 고른 분류를 기억하면
    // 그 뒤 모든 결제가 끌려간다 (2026-11-12 실제로 미용>헤어가 네이버페이 전체에 붙어 있었다)
    const add = (id: number, merchant: string) =>
      db.raw
        .prepare("INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, source, dedupe_key) VALUES ('expense','active','2026-03-03','10:00:00',?,-20000,'notify',?)")
        .run(merchant, `n${id}`);
    add(1, "네이버페이");
    add(2, "가짜미용실");
    const patch = (id: number) =>
      call(`/transactions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newCategory: "미용 > 헤어" }) });
    const remembered = (m: string) => db.raw.prepare("SELECT value FROM ledger_settings WHERE key = ?").get(`notify.category.${m}`);

    await patch(5);
    expect(remembered("네이버페이")).toBeUndefined(); // 길목 이름은 안 남긴다
    await patch(6);
    expect(remembered("가짜미용실")).toBeDefined(); // 진짜 가게는 그대로 기억한다

    // 이미 들어 있던 잘못된 기억은 분류를 비워서 지울 수 있어야 한다
    db.raw.prepare("INSERT INTO ledger_settings (key, value) VALUES ('notify.category.네이버페이', '1')").run();
    await call("/transactions/5", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categoryId: null }) });
    expect(remembered("네이버페이")).toBeUndefined();
  });

  it("엑셀 줄의 분류를 골라도 알림용 기억은 안 남긴다", async () => {
    await call("/transactions/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newCategory: "가짜분류" }) });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM ledger_settings WHERE key LIKE 'notify.category.%'").get()).toMatchObject({ n: 0 });
  });

  it("알림 화면: 마지막 수신·임시 거래·원문·자동 가져오기 상태를 한 번에 준다", async () => {
    const hdr = { "Content-Type": "application/json" };
    const notify = (body: string) => call("/notify", { method: "POST", headers: hdr, body: JSON.stringify({ app: "현대카드", body }) });
    await notify("광고 — 이번 달 혜택을 확인하세요");
    await notify("홍길동 님, 현대 ZERO 승인\n12,000원 일시불, 3/5 11:09\n가짜약국\n누적1원");
    await call("/sync-status", { method: "POST", headers: hdr, body: JSON.stringify({ ok: false, step: "fetch", error: "가짜 오류" }) });

    const o = (await (await call("/notify/overview")).json()) as {
      status: { lastAt: string | null; lastApp: string | null; pending: number };
      sync: { failStreak: number; lastError: string | null } | null;
      provisional: { merchant: string; provisional: boolean; category: string | null }[];
      recent: { app: string; excerpt: string; parsed: boolean }[];
    };
    expect(o.status.lastApp).toBe("현대카드");
    expect(o.status.lastAt).toBeTruthy();
    expect(o.status.pending).toBe(1);
    expect(o.sync).toMatchObject({ failStreak: 1, lastError: "가짜 오류" });
    expect(o.provisional).toHaveLength(1);
    expect(o.provisional[0]).toMatchObject({ merchant: "가짜약국", provisional: true, category: "약국" });
    // 최신이 먼저. 거래가 된 것과 아닌 것이 구분된다
    expect(o.recent.map((r) => r.parsed)).toEqual([true, false]);
    expect(o.recent[1]!.excerpt).toContain("광고");
  });

  it("알림이 하나도 없으면 빈 상태를 준다", async () => {
    const o = (await (await call("/notify/overview")).json()) as { status: { lastAt: null; pending: number }; sync: null; provisional: unknown[]; recent: unknown[] };
    expect(o).toEqual({ status: { lastAt: null, lastApp: null, pending: 0 }, sync: null, provisional: [], recent: [] });
  });

  it("lists active transactions in a range, untimed first", async () => {
    const res = await call("/transactions?from=2026-03-01&to=2026-03-31");
    const rows = (await res.json()) as { merchant: string }[];
    expect(rows.map((r) => r.merchant)).toEqual(["가짜관리비", "가짜식당"]);
  });

  it("rejects a malformed range", async () => {
    expect((await call("/transactions?from=2026-3-1&to=x")).status).toBe(400);
  });

  it("updates and clears a memo", async () => {
    const patch = (memo: string | null) =>
      call("/transactions/1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memo }),
      });

    expect(await (await patch("  친구랑 점심  ")).json()).toEqual({ memo: "친구랑 점심", note: null, tags: [] });
    expect(db.raw.prepare("SELECT memo FROM ledger_transactions WHERE id = 1").get()).toEqual({ memo: "친구랑 점심" });
    expect(await (await patch("")).json()).toEqual({ memo: null, note: null, tags: [] });
    expect((await call("/transactions/999", { method: "PATCH", body: '{"memo":"x"}' })).status).toBe(404);
  });

  it("keeps a detail note next to the one-line memo", async () => {
    const patch = (body: unknown) =>
      call("/transactions/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await patch({ memo: "장보기" });
    expect(await (await patch({ note: "가짜 계란 30구\r\n가짜 휴지  " })).json()).toEqual({ memo: "장보기", note: "가짜 계란 30구\n가짜 휴지", tags: [] });
    expect(db.raw.prepare("SELECT memo FROM ledger_transactions WHERE id = 1").get()).toEqual({ memo: "장보기\n가짜 계란 30구\n가짜 휴지" });
    // 한 줄 메모만 바꿔도 상세는 남고, 한 줄 메모를 비워도 상세는 남는다
    expect(await (await patch({ memo: "마트\n줄바꿈" })).json()).toEqual({ memo: "마트 줄바꿈", note: "가짜 계란 30구\n가짜 휴지", tags: [] });
    expect(await (await patch({ memo: null })).json()).toEqual({ memo: null, note: "가짜 계란 30구\n가짜 휴지", tags: [] });
    const listed = (await (await call("/transactions?from=2026-03-01&to=2026-03-01")).json()) as { id: number }[];
    expect(listed.find((t) => t.id === 1)).toMatchObject({ memo: null, note: "가짜 계란 30구\n가짜 휴지" });
    expect(await (await patch({ note: "" })).json()).toEqual({ memo: null, note: null, tags: [] });
    expect(db.raw.prepare("SELECT memo FROM ledger_transactions WHERE id = 1").get()).toEqual({ memo: null });
  });

  it("searches merchants, memos, detail notes and amounts", async () => {
    const patch = (id: number, body: unknown) =>
      call(`/transactions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await patch(2, { memo: "3월분", note: "가짜 계란 30구\n50%_할인" });
    const search = async (q: string) =>
      ((await (await call(`/search?q=${encodeURIComponent(q)}`)).json()) as { results: { id: number; note: string | null }[] }).results.map((r) => r.id);
    expect(await search("식당")).toEqual([1]);
    expect(await search("계란")).toEqual([2]); // 상세 메모
    expect(await search("3월")).toEqual([2]);
    expect(await search("40,000")).toEqual([1]); // 금액
    expect(await search("%_")).toEqual([2]); // LIKE 특수문자는 글자 그대로
    expect(await search("%")).toEqual([2]);
    expect(await search("보험")).toEqual([]); // 확인 필요는 빼고
    expect(await search("")).toEqual([]);
    // 카테고리 이름 (대분류로 찾으면 소분류까지), 미분류
    await patch(1, { newCategory: "식비 > 중식" });
    expect(await search("식비")).toEqual([1]);
    expect(await search("중식")).toEqual([1]);
    expect(await search("미분류")).toEqual([4, 2]); // 이체(확인 필요 포함)는 빼고
    // 띄어쓰기 = AND
    expect(await search("미분류 관리비")).toEqual([2]);
    expect(await search("가짜 40,000")).toEqual([1]);
    expect(await search("미분류 없는말")).toEqual([]);
    // 최근 날짜부터, 같은 날은 늦은 시각부터 (시간 없는 건 그날 맨 뒤)
    expect(await search("가짜")).toEqual([1, 2]);
  });

  it("changes a transaction's category by id or by a new name", async () => {
    const patch = (body: unknown) =>
      call("/transactions/1", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const made = (await (await patch({ newCategory: "식비 > 중식" })).json()) as { categoryId: number };
    expect(db.raw.prepare("SELECT category_id AS id, category_source AS src, memo FROM ledger_transactions WHERE id = 1").get()).toEqual({ id: made.categoryId, src: "manual", memo: null });
    expect(await (await patch({ categoryId: null })).json()).toEqual({ categoryId: null });
    expect((await patch({ categoryId: "x" })).status).toBe(400);
  });

  it("stores and deletes settings", async () => {
    const put = (key: string, value: string | null) =>
      call("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) });
    expect((await put("tax.2026.salary", "10000000")).status).toBe(200);
    await put("payment.가짜카드", "debit");
    expect(await (await call("/settings")).json()).toEqual({ "tax.2026.salary": "10000000", "payment.가짜카드": "debit" });
    await put("tax.2026.salary", null);
    expect(await (await call("/settings")).json()).toEqual({ "payment.가짜카드": "debit" });
    expect((await call("/settings", { method: "PUT", body: "{}" })).status).toBe(400);
  });
});

describe("imports api", () => {
  const row = (merchant: string, amount: number, key: string) => ({
    kind: "expense",
    date: "2026-05-01",
    time: null,
    merchant,
    amount,
    paymentMethod: "가짜카드",
    sourceCategory: { major: "식비", minor: "한식" },
    dedupeKey: key.padEnd(64, "0"),
  });
  const payload = {
    source: "banksalad-xlsx",
    fileName: "fake.xlsx",
    fileSha256: "f".repeat(64),
    rows: [row("가게A", -1000, "a"), row("가게B", -2000, "b")],
    skipped: [],
    snapshot: null,
  };
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("previews without saving, then saves and dedupes", async () => {
    expect(await (await post("/imports/preview", payload)).json()).toMatchObject({ new: 2, duplicates: 0 });
    expect(db.raw.prepare("SELECT count(*) AS n FROM ledger_transactions").get()).toEqual({ n: 4 });
    expect(await (await post("/imports", payload)).json()).toMatchObject({ inserted: 2 });
    expect(await (await post("/imports", payload)).json()).toMatchObject({ inserted: 0, duplicates: 2 });
  });

  it("appends later chunks to the first chunk's import record", async () => {
    const first = (await (await post("/imports", { ...payload, rows: [payload.rows[0]] })).json()) as { batchId: number };
    const second = await (await post("/imports", { ...payload, rows: [payload.rows[1]], batchId: first.batchId })).json();
    expect(second).toMatchObject({ batchId: first.batchId, inserted: 1 });
    expect(db.raw.prepare("SELECT total_rows, inserted FROM ledger_import_batches").all()).toEqual([{ total_rows: 2, inserted: 2 }]);
    expect((await post("/imports", { ...payload, batchId: 999 })).status).toBe(422);
  });

  it("rejects malformed rows", async () => {
    const bad = { ...payload, rows: [{ ...payload.rows[0], amount: 1.5 }] };
    expect((await post("/imports/preview", bad)).status).toBe(422);
    expect((await post("/imports/preview", { ...payload, source: "unknown" })).status).toBe(422);
  });
});
