import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { CategoryError, deleteCategory, listCategoryUsage, mergeCategory, renameCategory, reorderCategories } from "./category-admin.ts";
import { ensureCategory, ensureCategoryPath } from "./categories.ts";

let db: SqliteDb;
beforeEach(() => {
  db = openMigratedSqlite();
});

/** `대분류 > 소분류` 를 만들고 그 id 로 거래 n 건을 넣는다 */
async function withTxs(path: string, n: number): Promise<number> {
  const id = await ensureCategoryPath(db, path);
  for (let i = 0; i < n; i++) {
    await db
      .prepare(
        `INSERT INTO ledger_transactions (kind, date, merchant, amount, category_id, source)
         VALUES ('expense', '2026-10-01', ?, -1000, ?, 'manual')`,
      )
      .bind(`가짜가게${path}${i}`, id)
      .run();
  }
  return id;
}

const usage = async (id: number) => (await listCategoryUsage(db, { cached: false })).find((c) => c.id === id);
const names = async () => (await listCategoryUsage(db, { cached: false })).map((c) => c.name);

describe("카테고리 관리", () => {
  it("쓰임새를 센다 — 거래와 자동 분류 규칙 둘 다", async () => {
    const id = await withTxs("식비 > 분식", 3);
    await db.prepare("INSERT INTO ledger_transfer_rules (counterparty, action, category_id) VALUES ('가짜분식', 'expense', ?)").bind(id).run();
    expect(await usage(id)).toMatchObject({ name: "분식", transactions: 3, rules: 1 });
  });

  it("이름을 바꾼다. 같은 부모 밑 같은 이름은 거절", async () => {
    const id = await withTxs("식비 > 분식", 1);
    await ensureCategoryPath(db, "식비 > 한식");
    await renameCategory(db, id, " 중식 ");
    expect(await names()).toContain("중식");
    await expect(renameCategory(db, id, "한식")).rejects.toThrow(CategoryError);
    await expect(renameCategory(db, id, "  ")).rejects.toThrow("이름이 비어 있어요");
  });

  it("합치면 거래와 규칙이 따라가고 원래 카테고리는 사라진다", async () => {
    const from = await withTxs("식비 > 분식", 2);
    const into = await withTxs("식비 > 한식", 1);
    await db.prepare("INSERT INTO ledger_transfer_rules (counterparty, action, category_id) VALUES ('가짜분식', 'expense', ?)").bind(from).run();

    expect(await mergeCategory(db, from, into)).toEqual({ moved: 2 });
    expect(await usage(into)).toMatchObject({ transactions: 3, rules: 1 });
    expect(await usage(from)).toBeUndefined();
  });

  it("대분류를 합치면 하위 분류도 따라가고, 같은 이름끼리는 다시 합쳐진다", async () => {
    const oldMinor = await withTxs("식사 > 한식", 2);
    const onlyHere = await withTxs("식사 > 야식", 1);
    const newMinor = await withTxs("식비 > 한식", 3);
    const oldMajor = await ensureCategory(db, "식사", null);
    const newMajor = await ensureCategory(db, "식비", null);

    // 옮긴 2건은 '한식' 것뿐이다 — '야식' 은 카테고리가 그대로고 대분류만 갈아탄다
    expect(await mergeCategory(db, oldMajor, newMajor)).toEqual({ moved: 2 });
    expect(await usage(newMinor)).toMatchObject({ transactions: 5 });
    expect(await usage(oldMinor)).toBeUndefined();
    // 받는 쪽에 없던 '야식' 은 거래를 그대로 들고 새 대분류 밑으로
    expect(await usage(onlyHere)).toMatchObject({ name: "야식", parentId: newMajor, transactions: 1 });
    expect(await usage(oldMajor)).toBeUndefined();
  });

  it("자기 하위 분류나 소분류로는 합칠 수 없다", async () => {
    await withTxs("식비 > 분식", 1);
    const major = await ensureCategory(db, "식비", null);
    const minor = await ensureCategoryPath(db, "식비 > 분식");
    await expect(mergeCategory(db, major, minor)).rejects.toThrow("자기 하위 분류");
    const other = await ensureCategoryPath(db, "교통 > 택시");
    await expect(mergeCategory(db, major, other)).rejects.toThrow("소분류로 합칠 수 없어요");
    await expect(mergeCategory(db, major, major)).rejects.toThrow("같은 카테고리예요");
  });

  it("쓰는 데가 있으면 못 지운다 — 거래 · 규칙 · 하위 분류", async () => {
    const used = await withTxs("식비 > 분식", 2);
    await expect(deleteCategory(db, used)).rejects.toThrow("2건이 이 카테고리로");
    await expect(deleteCategory(db, await ensureCategory(db, "식비", null))).rejects.toThrow("하위 분류가 남아 있어요");

    const ruled = await ensureCategoryPath(db, "교통 > 택시");
    await db.prepare("INSERT INTO ledger_transfer_rules (counterparty, action, category_id) VALUES ('가짜택시', 'expense', ?)").bind(ruled).run();
    await expect(deleteCategory(db, ruled)).rejects.toThrow("자동 분류 규칙 1개");
  });

  it("비어 있으면 지워진다", async () => {
    const empty = await ensureCategoryPath(db, "식비 > 분식");
    await deleteCategory(db, empty);
    expect(await usage(empty)).toBeUndefined();
  });

  it("오타로 만든 카테고리를 치우는 길: 지우기는 거절, 합치기는 된다", async () => {
    const typo = await withTxs("식비 > 분싟", 2);
    const right = await ensureCategoryPath(db, "식비 > 분식");
    await expect(deleteCategory(db, typo)).rejects.toThrow("다른 카테고리로 합쳐 주세요");
    expect(await mergeCategory(db, typo, right)).toEqual({ moved: 2 });
    expect(await names()).not.toContain("분싟");
    expect(await usage(right)).toMatchObject({ transactions: 2 });
  });

  it("순서를 바꾼다. 목록이 다르면 거절", async () => {
    const a = await ensureCategory(db, "식비", null);
    const b = await ensureCategory(db, "교통", null);
    const c = await ensureCategory(db, "주거", null);
    await reorderCategories(db, null, [c, a, b]);
    const majors = (await listCategoryUsage(db, { cached: false })).filter((x) => x.parentId === null);
    expect(majors.map((x) => x.name)).toEqual(["주거", "식비", "교통"]);

    await expect(reorderCategories(db, null, [c, a])).rejects.toThrow("목록이 그새 바뀌었어요");
    await expect(reorderCategories(db, null, [c, a, 9999])).rejects.toThrow(CategoryError);
  });

  it("소분류 순서는 그 대분류 안에서만 매긴다", async () => {
    const major = await ensureCategory(db, "식비", null);
    const han = await ensureCategoryPath(db, "식비 > 한식");
    const bun = await ensureCategoryPath(db, "식비 > 분식");
    await reorderCategories(db, major, [bun, han]);
    const minors = (await listCategoryUsage(db, { cached: false })).filter((x) => x.parentId === major);
    expect(minors.map((x) => x.name)).toEqual(["분식", "한식"]);
  });
});
