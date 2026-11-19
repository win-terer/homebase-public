import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { ledgerServer } from "./index.ts";
import { forgetMemoUses } from "./memos.ts";
import { importFakeRows } from "./testing.ts";

let db: SqliteDb;
let api: ReturnType<typeof ledgerServer.createApi>;
const call = (path: string, init?: RequestInit) => api.request(path, init, { DB: db });
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const memos = () => db.raw.prepare("SELECT id, amount, memo FROM ledger_transactions ORDER BY id").all();

const PG = "가짜결제대행_카드";

beforeEach(() => {
  db = openMigratedSqlite();
  api = ledgerServer.createApi();
  forgetMemoUses();
  const insert = db.raw.prepare("INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, memo, source) VALUES ('expense', 'active', ?, '07:45:00', ?, ?, ?, 'manual')");
  insert.run("2026-09-28", PG, -3700, null); // 1
  insert.run("2026-09-29", PG, -3700, null); // 2
  insert.run("2026-09-30", PG, -3700, "\n가짜 상세"); // 3: 상세만 있음
  insert.run("2026-09-30", PG, -9900, null); // 4: 금액 다름
  insert.run("2026-09-30", PG, -3700, "다른 메모"); // 5: 이미 메모
  insert.run("2026-09-30", "다른가게", -3700, null); // 6
});

describe("memo helpers", () => {
  it("counts and fills payments without a memo, keeping detail notes and existing memos", async () => {
    await call("/transactions/1", json("PATCH", { memo: "가짜카페" }));
    expect(await (await call(`/memos/similar?merchant=${encodeURIComponent(PG)}&amount=-3700`)).json()).toEqual({ sameAmount: 2, sameMerchant: 3 });

    expect(await (await call("/memos/apply", json("POST", { merchant: PG, amount: -3700, memo: "가짜카페", remember: false }))).json()).toEqual({ updated: 2 });
    expect(memos()).toEqual([
      { id: 1, amount: -3700, memo: "가짜카페" },
      { id: 2, amount: -3700, memo: "가짜카페" },
      { id: 3, amount: -3700, memo: "가짜카페\n가짜 상세" },
      { id: 4, amount: -9900, memo: null },
      { id: 5, amount: -3700, memo: "다른 메모" },
      { id: 6, amount: -3700, memo: null },
    ]);
    // 금액 상관없이
    expect(await (await call("/memos/apply", json("POST", { merchant: PG, amount: null, memo: "가짜카페", remember: false }))).json()).toEqual({ updated: 1 });
    expect((await call("/memos/apply", json("POST", { merchant: PG, amount: -1, memo: " " }))).status).toBe(400);
  });

  it("suggests past memos with merchant, amount and count", async () => {
    await call("/memos/apply", json("POST", { merchant: PG, amount: -3700, memo: "가짜카페", remember: false }));
    const list = (await (await call("/memos")).json()) as { memo: string; merchant: string; amount: number; count: number }[];
    expect(list.find((m) => m.memo === "가짜카페")).toMatchObject({ merchant: PG, amount: -3700, count: 3 }); // 상세가 달라도 한 줄 메모가 같으면 합침
    expect(list.find((m) => m.memo === "다른 메모")).toMatchObject({ count: 1 });
  });

  it("remembers a rule and fills it on the next import", async () => {
    await call("/memos/apply", json("POST", { merchant: PG, amount: -3700, memo: "가짜카페", remember: true }));
    await importFakeRows(db, [
      { date: "2026-10-02", time: "07:50:00", type: "지출", major: "식비", minor: "카페", merchant: PG, amount: -3700 },
      { date: "2026-10-02", time: "12:00:00", type: "지출", major: "식비", minor: "카페", merchant: PG, amount: -4500 },
    ]);
    const rows = db.raw.prepare("SELECT amount, memo FROM ledger_transactions WHERE date = '2026-10-02' ORDER BY amount").all();
    expect(rows).toEqual([
      { amount: -4500, memo: null },
      { amount: -3700, memo: "가짜카페" },
    ]);
  });
});

describe("category helpers", () => {
  it("changes the category of the same payments except ones the user picked, and remembers a rule", async () => {
    const cat = (await (await call("/transactions/1", json("PATCH", { newCategory: "카페/간식 > 커피/음료" }))).json()) as { categoryId: number };
    // 2 는 사용자가 이미 다른 걸 골랐다
    await call("/transactions/2", json("PATCH", { newCategory: "식비 > 외식" }));
    expect(await (await call(`/categories/similar?merchant=${encodeURIComponent(PG)}&amount=-3700&categoryId=${cat.categoryId}`)).json()).toEqual({ sameAmount: 2, sameMerchant: 3 });
    expect(await (await call("/categories/apply", json("POST", { merchant: PG, amount: -3700, categoryId: cat.categoryId, remember: true }))).json()).toEqual({ updated: 2 });
    const rows = db.raw.prepare("SELECT id, category_id AS c, category_source AS s FROM ledger_transactions WHERE merchant = ? ORDER BY id").all(PG) as { id: number; c: number | null; s: string | null }[];
    expect(rows.filter((r) => r.c === cat.categoryId).map((r) => r.id)).toEqual([1, 3, 5]);
    expect(rows.find((r) => r.id === 4)!.c).toBeNull(); // 금액 다름
    await importFakeRows(db, [{ date: "2026-10-03", time: "07:50:00", type: "지출", major: "식비", minor: "카페", merchant: PG, amount: -3700 }]);
    expect(db.raw.prepare("SELECT category_id AS c, category_source AS s FROM ledger_transactions WHERE date = '2026-10-03'").get()).toEqual({ c: cat.categoryId, s: "rule" });
  });
});
