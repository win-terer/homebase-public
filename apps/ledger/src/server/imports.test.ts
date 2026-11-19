import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import type { FakeRow } from "../importers/testing/fake-banksalad.ts";
import { importFakeRows } from "./testing.ts";

let db: SqliteDb;
beforeEach(() => {
  db = openMigratedSqlite();
});

const importRows = (rows: FakeRow[]) => importFakeRows(db, rows);

const ROWS: FakeRow[] = [
  { date: "2026-03-01", time: "12:00:00", type: "지출", major: "식비", minor: "한식", merchant: "가짜식당", amount: -40000 },
  { date: "2026-03-01", time: "12:40:00", type: "이체", major: "이체", merchant: "친구A", amount: 20000 },
  { date: "2026-03-02", time: "09:00:00", type: "이체", major: "내계좌이체", merchant: "내 통장", amount: -100000 },
  { date: "2026-03-02", time: "10:00:00", type: "이체", major: "카드대금", merchant: "가짜카드", amount: -500000 },
  { date: "2026-03-03", time: "08:00:00", type: "이체", major: "미분류", merchant: "가짜보험", amount: -30000 },
];

describe("imports", () => {
  it("imports new rows and applies transfer policy", async () => {
    const result = await importRows(ROWS);
    expect(result).toMatchObject({
      total: 5,
      new: 3,
      newByKind: { expense: 1, income: 0, transfer: 2 },
      duplicates: 0,
      review: 1,
      excluded: { 내계좌이체: 1, 카드대금: 1 },
      inserted: 3,
      period: { from: "2026-03-01", to: "2026-03-03" },
    });

    const statuses = db.raw.prepare("SELECT merchant, status FROM ledger_transactions ORDER BY id").all();
    expect(statuses).toEqual([
      { merchant: "가짜식당", status: "active" },
      { merchant: "친구A", status: "active" },
      { merchant: "가짜보험", status: "review" },
    ]);
  });

  it("skips duplicates on re-import and keeps user edits", async () => {
    await importRows(ROWS);
    db.raw.prepare("UPDATE ledger_transactions SET memo = '점심' WHERE merchant = '가짜식당'").run();

    const again = await importRows([
      ...ROWS,
      { date: "2026-03-04", type: "지출", merchant: "새가게", amount: -1000 },
    ]);
    expect(again).toMatchObject({ new: 1, duplicates: 3, inserted: 1 });
    expect(db.raw.prepare("SELECT memo FROM ledger_transactions WHERE merchant = '가짜식당'").get()).toEqual({
      memo: "점심",
    });
  });

  it("keeps identical payments made twice", async () => {
    const same: FakeRow = { date: "2026-03-05", time: "15:00:00", type: "지출", merchant: "가짜카페", amount: -4500 };
    expect(await importRows([same, same])).toMatchObject({ new: 2, inserted: 2 });
    expect(await importRows([same, same])).toMatchObject({ new: 0, duplicates: 2 });
  });

  it("lets user transfer rules override the source", async () => {
    db.raw.prepare("INSERT INTO ledger_transfer_rules (counterparty, action) VALUES ('가짜보험', 'exclude')").run();
    const result = await importRows(ROWS);
    expect(result.review).toBe(0);
    expect(result.excluded).toMatchObject({ "규칙: 가짜보험": 1 });
  });

  it("creates categories from the source", async () => {
    await importRows(ROWS);
    const cats = db.raw
      .prepare(
        `SELECT c.name, p.name AS parent FROM ledger_categories c
         LEFT JOIN ledger_categories p ON p.id = c.parent_id ORDER BY c.id`,
      )
      .all();
    expect(cats).toEqual([
      { name: "식비", parent: null },
      { name: "외식", parent: "식비" },
    ]);
  });
});

describe("transfer rules", () => {
  it("groups counterparties whose names differ only by trailing digits", async () => {
    db.raw.prepare("INSERT INTO ledger_transfer_rules (counterparty, action) VALUES ('가짜생명', 'expense')").run();
    const result = await importRows([
      { date: "2026-03-10", type: "이체", major: "미분류", merchant: "가짜생명01000", amount: -60000 },
      { date: "2026-04-10", type: "이체", major: "미분류", merchant: "가짜생명02000", amount: -60000 },
    ]);
    expect(result).toMatchObject({ new: 2, review: 0, newByKind: { expense: 2 } });
    expect(db.raw.prepare("SELECT DISTINCT kind, status FROM ledger_transactions").all()).toEqual([
      { kind: "expense", status: "active" },
    ]);
  });
});

describe("엑셀이 덮으면 임시 거래는 사라진다", () => {
  /** 폰 알림으로 만들어 둔 임시 거래 (source = 'notify') */
  const putProvisional = (date: string) =>
    db.raw
      .prepare(
        "INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, source, dedupe_key) VALUES ('expense', 'active', ?, '12:00:00', '가짜상점', -1000, 'notify', ?)",
      )
      .run(date, `notify-${date}`);

  const sources = () => (db.raw.prepare("SELECT source, date FROM ledger_transactions ORDER BY date, id").all() as { source: string; date: string }[]);

  it("가져온 기간 안의 임시 거래를 치운다", async () => {
    putProvisional("2026-03-02");
    await importRows(ROWS); // 2026-03-01 ~ 2026-03-03
    expect(sources().filter((r) => r.source === "notify")).toHaveLength(0);
  });

  it("기간 밖의 임시 거래는 그대로 둔다 (아직 엑셀이 안 덮은 날)", async () => {
    putProvisional("2026-03-10");
    await importRows(ROWS);
    expect(sources().filter((r) => r.source === "notify").map((r) => r.date)).toEqual(["2026-03-10"]);
  });

  it("확정 거래는 건드리지 않는다", async () => {
    await importRows(ROWS);
    const before = sources().length;
    putProvisional("2026-03-02");
    await importRows(ROWS); // 같은 걸 다시 — 중복이라 새로 안 들어가고, 임시만 사라진다
    expect(sources()).toHaveLength(before);
  });
});

describe("앱 알림에 적어 둔 메모·분류는 엑셀이 덮어도 남는다", () => {
  /** 결제 직후 앱 알림으로 들어온 줄에 사람이 메모·분류를 달아 둔 상태를 만든다 */
  const putEdited = (opts: { date: string; time: string | null; amount: number; memo?: string; categoryId?: number }) =>
    db.raw
      .prepare(
        "INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, memo, category_id, category_source, source, dedupe_key) VALUES ('expense', 'active', ?, ?, '네이버파이낸셜(주)', ?, ?, ?, ?, 'notify', ?)",
      )
      .run(opts.date, opts.time, opts.amount, opts.memo ?? null, opts.categoryId ?? null, opts.categoryId ? "manual" : null, `notify-${opts.date}-${opts.amount}`);

  const find = (merchant: string) =>
    db.raw.prepare("SELECT memo, category_id AS categoryId, category_source AS categorySource, source FROM ledger_transactions WHERE merchant = ?").get(merchant) as
      | { memo: string | null; categoryId: number | null; categorySource: string | null; source: string }
      | undefined;

  it("메모가 엑셀 줄로 옮겨진다 (가맹점 이름이 달라도 날짜·금액으로 찾는다)", async () => {
    putEdited({ date: "2026-03-01", time: "12:00:00", amount: -40000, memo: "동기 점심" });
    await importRows(ROWS);
    expect(find("가짜식당")?.memo).toBe("동기 점심");
    expect(find("가짜식당")?.source).toBe("banksalad-xlsx");
  });

  it("분류도 옮겨지고 '사람이 고른 것'으로 남는다 (규칙이 나중에 덮지 않게)", async () => {
    const cat = db.raw.prepare("INSERT INTO ledger_categories (name) VALUES ('가짜분류') RETURNING id").get() as { id: number };
    putEdited({ date: "2026-03-01", time: "12:00:00", amount: -40000, categoryId: cat.id });
    await importRows(ROWS);
    expect(find("가짜식당")).toMatchObject({ categoryId: cat.id, categorySource: "manual" });
  });

  it("옮긴 뒤 앱 알림 줄은 사라진다", async () => {
    putEdited({ date: "2026-03-01", time: "12:00:00", amount: -40000, memo: "동기 점심" });
    await importRows(ROWS);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM ledger_transactions WHERE source = 'notify'").get()).toMatchObject({ n: 0 });
  });

  it("같은 날 같은 금액이 여럿이면 시각이 똑같은 것에만 붙인다", async () => {
    // 같은 날·같은 금액을 하나 더 넣어 둔다 (시각이 다름)
    db.raw
      .prepare("INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, source, dedupe_key) VALUES ('expense','active','2026-03-01','20:00:00','다른가게',-40000,'banksalad','x1')")
      .run();
    putEdited({ date: "2026-03-01", time: "12:00:00", amount: -40000, memo: "동기 점심" });
    await importRows(ROWS);
    expect(find("가짜식당")?.memo).toBe("동기 점심");
    expect(find("다른가게")?.memo).toBeNull();
  });

  it("짝을 못 찾으면 아무 데도 붙이지 않고, 대신 '옮기지 못한 메모'로 남겨 둔다", async () => {
    putEdited({ date: "2026-03-01", time: "12:00:00", amount: -99999, memo: "짝 없음" });
    const result = await importRows(ROWS);
    const anyMemo = db.raw.prepare("SELECT COUNT(*) AS n FROM ledger_transactions WHERE memo = '짝 없음'").get() as { n: number };
    expect(anyMemo.n).toBe(0);
    expect(result.lostMemos).toBe(1);
    const kept = db.raw.prepare("SELECT value FROM ledger_settings WHERE key = 'notify.lost.2026-03-01.-99999.12:00:00'").get() as { value: string };
    expect(JSON.parse(kept.value)).toEqual({ memo: "짝 없음", categoryId: null, merchant: "네이버파이낸셜(주)" });
  });

  it("옮긴 메모는 남겨 두지 않는다", async () => {
    putEdited({ date: "2026-03-01", time: "12:00:00", amount: -40000, memo: "동기 점심" });
    const result = await importRows(ROWS);
    expect(result.lostMemos).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM ledger_settings WHERE key LIKE 'notify.lost.%'").get()).toMatchObject({ n: 0 });
  });

  /** 그 앱알림 줄에 사진을 붙여 둔다 (바이트는 KV 라 여기선 줄만) */
  const putPhoto = (id: string, merchant = "네이버파이낸셜(주)") =>
    db.raw
      .prepare("INSERT INTO core_photos (id, app, ref, bytes) SELECT ?, 'ledger', CAST(id AS TEXT), 10 FROM ledger_transactions WHERE merchant = ? AND source = 'notify'")
      .run(id, merchant);
  const photoRef = (id: string) => (db.raw.prepare("SELECT ref FROM core_photos WHERE id = ?").get(id) as { ref: string } | undefined)?.ref;
  const idOf = (merchant: string) => String((db.raw.prepare("SELECT id FROM ledger_transactions WHERE merchant = ?").get(merchant) as { id: number }).id);

  it("사진도 엑셀 줄로 옮겨진다 (메모 없이 사진만 붙인 줄도)", async () => {
    putEdited({ date: "2026-03-01", time: "12:00:00", amount: -40000 });
    putPhoto("p1");
    await importRows(ROWS);
    expect(photoRef("p1")).toBe(idOf("가짜식당"));
  });

  it("짝을 못 찾은 줄의 사진은 'lost:' 로 남기고 옮기지 못한 메모에 장수를 적는다", async () => {
    putEdited({ date: "2026-03-01", time: "12:00:00", amount: -99999 });
    putPhoto("p2");
    const result = await importRows(ROWS);
    expect(result.lostMemos).toBe(1);
    const key = "notify.lost.2026-03-01.-99999.12:00:00";
    expect(photoRef("p2")).toBe(`lost:${key}`);
    const kept = db.raw.prepare("SELECT value FROM ledger_settings WHERE key = ?").get(key) as { value: string };
    expect(JSON.parse(kept.value)).toMatchObject({ photos: 1 });
  });

    it("규칙으로 추측한 분류는 옮기지 않는다 (엑셀 분류가 이긴다)", async () => {
    const cat = db.raw.prepare("INSERT INTO ledger_categories (name) VALUES ('가짜추측') RETURNING id").get() as { id: number };
    putEdited({ date: "2026-03-01", time: "12:00:00", amount: -40000, categoryId: cat.id });
    db.raw.prepare("UPDATE ledger_transactions SET category_source = 'rule' WHERE source = 'notify'").run();
    await importRows(ROWS);
    expect(find("가짜식당")?.categoryId).not.toBe(cat.id);
  });

  it("손대지 않은 앱 알림 줄은 그냥 사라진다", async () => {
    putEdited({ date: "2026-03-01", time: "12:00:00", amount: -40000 });
    await importRows(ROWS);
    expect(find("가짜식당")?.memo).toBeNull();
  });
});
