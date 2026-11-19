import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { decideReview, listReviewGroups } from "./review.ts";
import type { FakeRow } from "../importers/testing/fake-banksalad.ts";
import { importFakeRows } from "./testing.ts";

let db: SqliteDb;
beforeEach(() => {
  db = openMigratedSqlite();
});

const importRows = (rows: FakeRow[]) => importFakeRows(db, rows);

const ROWS: FakeRow[] = [
  { date: "2026-01-10", type: "이체", major: "미분류", merchant: "가짜생명01000", amount: -60000 },
  { date: "2026-02-10", type: "이체", major: "미분류", merchant: "가짜생명02000", amount: -60000 },
  { date: "2026-02-20", type: "이체", major: "현금", merchant: "가짜렌탈", amount: -30000 },
  { date: "2026-02-23", type: "이체", major: "투자", merchant: "가짜보증금반환", amount: 1000000 },
  { date: "2026-02-26", type: "이체", major: "투자", merchant: "가짜회사", amount: 500000 },
  { date: "2026-03-01", type: "이체", major: "미분류", merchant: "가짜세이브", amount: -10000 },
];

describe("review", () => {
  it("groups review transfers by counterparty key", async () => {
    await importRows(ROWS);
    const groups = await listReviewGroups(db);
    expect(groups[0]).toMatchObject({
      counterparty: "가짜생명",
      names: ["가짜생명01000", "가짜생명02000"],
      count: 2,
      total: -120000,
      from: "2026-01-10",
      to: "2026-02-10",
    });
    expect(groups).toHaveLength(5);
  });

  it("applies each of the four actions and remembers them for next import", async () => {
    await importRows(ROWS);
    await decideReview(db, { counterparty: "가짜생명", action: "expense", newCategory: "보험" });
    await decideReview(db, { counterparty: "가짜렌탈", action: "expense", newCategory: "의료 > 렌탈" });
    await decideReview(db, { counterparty: "가짜보증금반환", action: "transfer" });
    await decideReview(db, { counterparty: "가짜회사", action: "income" });
    expect(await decideReview(db, { counterparty: "가짜세이브", action: "exclude" })).toEqual({ affected: 1 });

    expect(await listReviewGroups(db)).toEqual([]);
    const rows = db.raw
      .prepare(
        `SELECT t.merchant, t.kind, t.status, c.name AS category FROM ledger_transactions t
         LEFT JOIN ledger_categories c ON c.id = t.category_id ORDER BY t.date`,
      )
      .all();
    expect(rows).toEqual([
      { merchant: "가짜생명01000", kind: "expense", status: "active", category: "보험" },
      { merchant: "가짜생명02000", kind: "expense", status: "active", category: "보험" },
      { merchant: "가짜렌탈", kind: "expense", status: "active", category: "렌탈" },
      { merchant: "가짜보증금반환", kind: "transfer", status: "active", category: null },
      { merchant: "가짜회사", kind: "income", status: "active", category: null },
    ]);

    expect(db.raw.prepare("SELECT p.name FROM ledger_categories c JOIN ledger_categories p ON p.id = c.parent_id WHERE c.name = '렌탈'").get()).toEqual({ name: "의료" });

    // 다음 달 파일: 같은 상대방은 규칙대로 자동 처리
    const next = await importRows([
      { date: "2026-03-10", type: "이체", major: "미분류", merchant: "가짜생명03000", amount: -60000 },
      { date: "2026-03-15", type: "이체", major: "미분류", merchant: "가짜세이브", amount: -10000 },
    ]);
    expect(next).toMatchObject({ new: 1, review: 0, excluded: { "규칙: 가짜세이브": 1 } });
    expect(
      db.raw.prepare("SELECT c.name FROM ledger_transactions t JOIN ledger_categories c ON c.id = t.category_id WHERE merchant = '가짜생명03000'").get(),
    ).toEqual({ name: "보험" });
  });
});
