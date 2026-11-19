import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { ensureCategoryVersion, recategorizeAll, resetCategoryVersionCheck } from "./recategorize.ts";

let db: SqliteDb;
beforeEach(() => {
  db = openMigratedSqlite();
  const cat = db.raw.prepare("INSERT INTO ledger_categories (name, parent_id) VALUES (?, ?)");
  const food = Number(cat.run("식비", null).lastInsertRowid);
  const korean = Number(cat.run("한식", food).lastInsertRowid);
  const loan = Number(cat.run("대출 이자", null).lastInsertRowid);
  const mine = Number(cat.run("내가만든것", null).lastInsertRowid);
  const tx = db.raw.prepare(
    "INSERT INTO ledger_transactions (kind, date, time, merchant, amount, category_id, category_source, source_category, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test')",
  );
  tx.run("expense", "2026-09-15", "12:30:00", "가짜국밥", -9000, korean, "source", "식비 > 한식");
  tx.run("expense", "2026-09-15", "20:00:00", "가짜약국", -5000, null, null, "미분류 > 미분류");
  tx.run("expense", "2026-09-10", null, "가짜공사", -600000, loan, "rule", null);
  tx.run("expense", "2026-09-11", null, "가짜것", -1000, mine, "manual", null);
  db.raw.prepare("INSERT INTO ledger_transfer_rules (counterparty, action, category_id) VALUES ('가짜공사', 'expense', ?)").run(loan);
});

const categoryOf = (merchant: string) =>
  db.raw
    .prepare(
      `SELECT p.name AS major, c.name AS minor, t.category_source AS src FROM ledger_transactions t
       LEFT JOIN ledger_categories c ON c.id = t.category_id LEFT JOIN ledger_categories p ON p.id = c.parent_id WHERE merchant = ?`,
    )
    .get(merchant);

describe("recategorizeAll", () => {
  it("moves existing records to the new list and removes unused old categories", async () => {
    await recategorizeAll(db);
    expect(categoryOf("가짜국밥")).toEqual({ major: "식비", minor: "중식", src: "source" });
    expect(categoryOf("가짜약국")).toEqual({ major: "의료/건강", minor: "약국", src: "source" });
    expect(categoryOf("가짜공사")).toEqual({ major: "주거", minor: "대출 이자", src: "rule" });
    expect(categoryOf("가짜것")).toEqual({ major: null, minor: "내가만든것", src: "manual" });
    const rule = db.raw.prepare("SELECT c.name FROM ledger_transfer_rules r JOIN ledger_categories c ON c.id = r.category_id").get();
    expect(rule).toEqual({ name: "대출 이자" });
    const names = (db.raw.prepare("SELECT name FROM ledger_categories WHERE parent_id IS NULL ORDER BY sort_order, name").all() as { name: string }[]).map((r) => r.name);
    expect(names.slice(0, 3)).toEqual(["내가만든것", "식비", "카페/간식"]); // 사용자가 만든 건 남김 (순서 0)
    expect(names).not.toContain("대출 이자");
    expect(db.raw.prepare("SELECT count(*) AS n FROM ledger_categories WHERE name = '한식'").get()).toEqual({ n: 0 });
  });

  it("runs once per version", async () => {
    resetCategoryVersionCheck();
    await ensureCategoryVersion(db);
    expect(categoryOf("가짜약국")).toMatchObject({ minor: "약국" });
    db.raw.prepare("UPDATE ledger_transactions SET category_id = NULL, category_source = NULL WHERE merchant = '가짜약국'").run();
    resetCategoryVersionCheck();
    await ensureCategoryVersion(db); // 버전이 이미 2
    expect(categoryOf("가짜약국")).toEqual({ major: null, minor: null, src: null });
    expect(db.raw.prepare("SELECT count(*) AS n FROM ledger_scratch").get()).toEqual({ n: 0 });
  });

  it("lets only one request run while another is moving", async () => {
    resetCategoryVersionCheck();
    db.raw.prepare("INSERT INTO app_meta (key, value) VALUES ('ledger.category_version', ?)").run(`running:${Date.now()}`);
    await ensureCategoryVersion(db);
    expect(categoryOf("가짜약국")).toEqual({ major: null, minor: null, src: null }); // 건드리지 않음
    db.raw.prepare("UPDATE app_meta SET value = ? WHERE key = 'ledger.category_version'").run(`running:${Date.now() - 10 * 60_000}`);
    await ensureCategoryVersion(db); // 오래된 차지는 넘겨받는다
    expect(categoryOf("가짜약국")).toMatchObject({ minor: "약국" });
  });

  it("stops retrying after three failed attempts", async () => {
    resetCategoryVersionCheck();
    db.raw.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('ledger.category_version', ?)").run(`failed:${Date.now() - 10 * 60_000}:3`);
    const error = console.error;
    console.error = () => {};
    try {
      await ensureCategoryVersion(db);
    } finally {
      console.error = error;
    }
    expect(categoryOf("가짜약국")).toEqual({ major: null, minor: null, src: null }); // 다시 시도하지 않음
    db.raw.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('ledger.category_version', ?)").run(`failed:${Date.now() - 10 * 60_000}:2`);
    resetCategoryVersionCheck();
    await ensureCategoryVersion(db); // 세 번째 시도는 한다
    expect(categoryOf("가짜약국")).toMatchObject({ minor: "약국" });
  });
});
