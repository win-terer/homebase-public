/**
 * 카테고리 관리 — 이름 바꾸기 · 합치기 · 지우기 · 순서.
 *
 * 그동안 카테고리는 **만들기만** 됐다. 거래의 카테고리를 고르다가 `식비 > 분식` 을 치면
 * 새로 생기는데, 고칠 길도 지울 길도 없어서 오타로 만든 것이 목록에 영원히 남았다
 * (사용자 지적 2026-10-06).
 *
 * ## 지우기는 비어 있을 때만
 *
 * 거래가 딸린 카테고리를 지우면 그 거래가 통째로 미분류가 된다 — 수백 건이 조용히 풀리는
 * 셈이라 되돌리기 어렵다. 그래서 거래·규칙이 하나라도 걸려 있으면 거절하고, 대신 **합치기**를
 * 둔다. 합치기는 거래를 받을 카테고리로 옮기고 빈 껍데기를 지우므로, 지우기는 늘 안전한
 * 동작으로 남는다.
 *
 * ## 합치기가 보는 것
 *
 * 카테고리를 가리키는 표는 둘이다 — `ledger_transactions.category_id` 와
 * 자동 분류 규칙 `ledger_transfer_rules.category_id`. 규칙을 빠뜨리면 다음 가져오기부터
 * 사라진 카테고리로 다시 분류하려 들기 때문에 둘 다 옮긴다.
 */
import { json, type SqlDb } from "@homebase/db";
import { revCached } from "./rev-cache.ts";

/** 사용자에게 그대로 보여 줄 수 있는 거절 사유 (라우터가 400 으로 바꾼다) */
export class CategoryError extends Error {}

export interface CategoryUsage {
  id: number;
  name: string;
  parentId: number | null;
  sort: number;
  /** 이 카테고리로 지정된 거래 수 (하위 분류 것은 하위가 센다) */
  transactions: number;
  /** 이 카테고리를 쓰는 자동 분류 규칙 수 */
  rules: number;
}

interface Row {
  id: number;
  name: string;
  parentId: number | null;
  sort: number;
}

/** 이름 길이 상한 (ensureCategoryPath 와 같게) */
const NAME_MAX = 30;

/** 여러 행을 한 번에 고칠 때 쓰는 임시 표 (recategorize.ts 와 같은 것) */
const SCRATCH_TABLE = "CREATE TABLE IF NOT EXISTS ledger_scratch (id INTEGER PRIMARY KEY, value INTEGER)";

const allCategories = async (db: SqlDb): Promise<Row[]> =>
  (await db.prepare("SELECT id, name, parent_id AS parentId, sort_order AS sort FROM ledger_categories").all<Row>()).results;

const countBy = async (db: SqlDb, table: string) =>
  (await db.prepare(`SELECT category_id AS id, count(*) AS n FROM ${table} WHERE category_id IS NOT NULL GROUP BY category_id`).all<{ id: number; n: number }>())
    .results;

/**
 * 카테고리별 쓰임새. 거래 집계는 표 전체를 훑으므로(7,000행) 데이터가 그대로면 다시 세지 않는다.
 *
 * `cached: false` 는 **고친 직후**에 쓴다 — 데이터 버전은 응답이 나간 뒤에 오르므로
 * (host/src/worker/app.ts), 같은 요청 안에서 캐시를 물으면 고치기 전 숫자가 나온다.
 */
export async function listCategoryUsage(db: SqlDb, { cached = true } = {}): Promise<CategoryUsage[]> {
  const count = async () => ({ txs: await countBy(db, "ledger_transactions"), rules: await countBy(db, "ledger_transfer_rules") });
  const [cats, counts] = await Promise.all([allCategories(db), cached ? revCached(db, "category-usage", count) : count()]);
  const txById = new Map(counts.txs.map((r) => [r.id, r.n]));
  const ruleById = new Map(counts.rules.map((r) => [r.id, r.n]));
  return cats
    .map((c) => ({ ...c, transactions: txById.get(c.id) ?? 0, rules: ruleById.get(c.id) ?? 0 }))
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ko"));
}

export async function renameCategory(db: SqlDb, id: number, rawName: string): Promise<void> {
  const name = rawName.trim().slice(0, NAME_MAX);
  if (!name) throw new CategoryError("이름이 비어 있어요");
  const cats = await allCategories(db);
  const me = cats.find((c) => c.id === id);
  if (!me) throw new CategoryError("없는 카테고리예요");
  if (me.name === name) return;
  // 같은 부모 밑 이름은 UNIQUE 다. DB 오류로 터뜨리는 대신 무엇이 걸렸는지 말해 준다
  if (cats.some((c) => c.id !== id && (c.parentId ?? 0) === (me.parentId ?? 0) && c.name === name)) {
    throw new CategoryError(`'${name}' 은 이미 있어요`);
  }
  await db.prepare("UPDATE ledger_categories SET name = ? WHERE id = ?").bind(name, id).run();
}

/**
 * `fromId` 의 거래·규칙을 `intoId` 로 옮기고 `fromId` 를 지운다.
 *
 * 대분류를 합치면 하위 분류도 따라간다. 받는 쪽에 **같은 이름의 하위 분류**가 이미 있으면
 * 그 둘끼리도 합친다 — 이름이 UNIQUE 라 그냥 옮기면 충돌하기 때문이다.
 */
export async function mergeCategory(db: SqlDb, fromId: number, intoId: number): Promise<{ moved: number }> {
  if (fromId === intoId) throw new CategoryError("같은 카테고리예요");
  const cats = await allCategories(db);
  const from = cats.find((c) => c.id === fromId);
  const into = cats.find((c) => c.id === intoId);
  if (!from || !into) throw new CategoryError("없는 카테고리예요");
  if (into.parentId === from.id) throw new CategoryError("자기 하위 분류로는 합칠 수 없어요");
  const children = cats.filter((c) => c.parentId === from.id);
  if (children.length && into.parentId !== null) throw new CategoryError("하위 분류가 있는 대분류는 소분류로 합칠 수 없어요");

  // 사라질 카테고리 → 그 거래를 받을 카테고리
  const moveTo = new Map<number, number>([[from.id, into.id]]);
  const reparent: number[] = [];
  for (const child of children) {
    const twin = cats.find((c) => c.parentId === into.id && c.name === child.name);
    if (twin) moveTo.set(child.id, twin.id);
    else reparent.push(child.id);
  }
  const gone = [...moveTo.keys()];

  // 받는 쪽으로 묶어서 한 문장씩 — 보통 한 쌍이라 문장 넷이면 끝난다 (D1 은 요청당 쿼리 수가 적다)
  const byTarget = new Map<number, number[]>();
  for (const [lost, target] of moveTo) byTarget.set(target, [...(byTarget.get(target) ?? []), lost]);
  const remap = (table: string) =>
    [...byTarget].map(([target, lost]) =>
      db.prepare(`UPDATE ${table} SET category_id = ? WHERE category_id IN (SELECT value FROM json_each(?))`).bind(target, json(lost)),
    );

  // 옮긴 건수는 UPDATE 가 센 것을 쓴다 — 따로 count 를 돌리면 거래 표를 한 번 더 훑는다
  const txMoves = remap("ledger_transactions");
  const results = await db.batch([
    ...txMoves,
    ...remap("ledger_transfer_rules"),
    ...(reparent.length
      ? [db.prepare("UPDATE ledger_categories SET parent_id = ? WHERE id IN (SELECT value FROM json_each(?))").bind(into.id, json(reparent))]
      : []),
    db.prepare("DELETE FROM ledger_categories WHERE id IN (SELECT value FROM json_each(?))").bind(json(gone)),
  ]);
  const moved = results.slice(0, txMoves.length).reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  return { moved };
}

export async function deleteCategory(db: SqlDb, id: number): Promise<void> {
  const cats = await allCategories(db);
  const me = cats.find((c) => c.id === id);
  if (!me) throw new CategoryError("없는 카테고리예요");
  // parent_id 는 ON DELETE CASCADE 라 대분류를 지우면 하위가 말없이 같이 사라진다. 먼저 막는다
  if (cats.some((c) => c.parentId === id)) throw new CategoryError("하위 분류가 남아 있어요. 하위부터 정리해 주세요");
  const [tx, rule] = await Promise.all([
    db.prepare("SELECT count(*) AS n FROM ledger_transactions WHERE category_id = ?").bind(id).first<{ n: number }>(),
    db.prepare("SELECT count(*) AS n FROM ledger_transfer_rules WHERE category_id = ?").bind(id).first<{ n: number }>(),
  ]);
  if (tx?.n) throw new CategoryError(`${tx.n.toLocaleString()}건이 이 카테고리로 되어 있어요. 다른 카테고리로 합쳐 주세요`);
  if (rule?.n) throw new CategoryError(`자동 분류 규칙 ${rule.n}개가 이 카테고리를 써요. 다른 카테고리로 합쳐 주세요`);
  await db.prepare("DELETE FROM ledger_categories WHERE id = ?").bind(id).run();
}

/**
 * 한 부모 밑 형제들의 순서를 `ids` 순서대로 (대분류는 `parentId = null`).
 *
 * 보낸 목록이 지금 형제 목록과 정확히 같을 때만 받는다. 다른 창에서 이미 지우거나 합친 뒤라면
 * 순서만 어긋나게 덮어쓰는 대신 새로고침을 요구한다.
 */
export async function reorderCategories(db: SqlDb, parentId: number | null, ids: number[]): Promise<void> {
  const cats = await allCategories(db);
  const siblings = cats.filter((c) => c.parentId === parentId).map((c) => c.id);
  if (siblings.length !== ids.length || siblings.some((id) => !ids.includes(id))) {
    throw new CategoryError("목록이 그새 바뀌었어요. 새로고침하고 다시 해 주세요");
  }
  // 기본 키가 있는 임시 표로 옮겨 키로 찾는다 — json_each 를 행마다 다시 훑는 상관 서브쿼리는
  // 금지다 (2026-09-30 D1 사고, recategorize.ts 와 같은 방식)
  const order = ids.map((id, i) => ({ id, sort: i + 1 }));
  await db.batch([
    db.prepare(SCRATCH_TABLE),
    db.prepare("DELETE FROM ledger_scratch"),
    db.prepare("INSERT INTO ledger_scratch (id, value) SELECT value ->> 'id', value ->> 'sort' FROM json_each(?)").bind(json(order)),
    db.prepare(
      "UPDATE ledger_categories SET sort_order = (SELECT s.value FROM ledger_scratch s WHERE s.id = ledger_categories.id) WHERE id IN (SELECT id FROM ledger_scratch)",
    ),
    db.prepare("DELETE FROM ledger_scratch"),
  ]);
}
