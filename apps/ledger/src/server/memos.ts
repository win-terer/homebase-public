import type { SqlDb, SqlValue } from "@homebase/db";
import { joinMemo, splitMemo } from "./memo.ts";
import { revCached } from "./rev-cache.ts";

/**
 * 메모 자동완성과 같은 결제에 한 번에 메모 넣기.
 * 결제대행사 이름(예: 한국결제네트웍스_카드)으로 찍히는 앱 주문은 원래 가게 이름 + 금액이 같으면 같은 곳일 때가 많다.
 */

export interface MemoUse {
  memo: string;
  /** 원래 가게 이름 (화면용으로 묶은 이름이 아님) */
  merchant: string;
  amount: number;
  count: number;
  last: string;
}

const TTL_MS = 10 * 60_000;
let cache: { at: number; list: MemoUse[] } | null = null;

/** 새 메모가 생기면 다음 조회 때 다시 읽는다 */
export const forgetMemoUses = () => {
  cache = null;
};

/** 지금까지 쓴 메모 (가게·금액·메모별 횟수). 전체를 한 번 훑으므로 인스턴스에 10분 둔다 */
export async function memoUses(db: SqlDb): Promise<MemoUse[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.list;
  // 표 전체를 훑는다(7,000건에 ~7천 행). isolate 가 죽어도 다시 하지 않게 D1 에 맡긴다 (rev-cache.ts)
  const rows = await revCached(db, "memo-uses", async () =>
    (
      await db
        .prepare(
          `SELECT merchant, amount, memo, count(*) AS n, max(date) AS last FROM ledger_transactions
           WHERE memo IS NOT NULL AND memo <> '' GROUP BY merchant, amount, memo`,
        )
        .all<{ merchant: string; amount: number; memo: string; n: number; last: string }>()
    ).results);
  // 상세 메모가 달라도 한 줄 메모가 같으면 하나로
  const map = new Map<string, MemoUse>();
  for (const r of rows) {
    const memo = splitMemo(r.memo).memo;
    if (!memo) continue;
    const key = `${r.merchant}\u001f${r.amount}\u001f${memo}`;
    const cur = map.get(key);
    if (cur) {
      cur.count += r.n;
      if (r.last > cur.last) cur.last = r.last;
    } else map.set(key, { memo, merchant: r.merchant, amount: r.amount, count: r.n, last: r.last });
  }
  cache = { at: Date.now(), list: [...map.values()] };
  return cache.list;
}

/** 메모가 없는 같은 가게 결제 수 (같은 금액 / 금액 상관없이) */
export async function similarWithoutMemo(db: SqlDb, merchant: string, amount: number): Promise<{ sameAmount: number; sameMerchant: number }> {
  const row = await db
    .prepare(
      `SELECT count(*) AS merchant, ifnull(sum(amount = ?), 0) AS amount FROM ledger_transactions
       WHERE merchant = ? AND status = 'active' AND (memo IS NULL OR memo = '' OR substr(memo, 1, 1) = char(10))`,
    )
    .bind(amount, merchant)
    .first<{ merchant: number; amount: number }>();
  return { sameAmount: row?.amount ?? 0, sameMerchant: row?.merchant ?? 0 };
}

export const memoRuleKey = (merchant: string, amount: number) => `memo.rule.${amount}.${merchant}`;

/**
 * 한 줄 메모가 없는 같은 가게(금액이 주어지면 같은 금액) 결제에 메모를 넣는다. 상세 메모는 그대로 둔다.
 * remember 면 다음 가져오기부터도 같은 가게·같은 금액에 자동으로 넣는다 (ledger_settings 에 규칙 저장).
 */
export async function applyMemo(
  db: SqlDb,
  input: { merchant: string; amount: number | null; memo: string; remember: boolean },
): Promise<{ updated: number }> {
  const memo = joinMemo(input.memo, null);
  if (!memo) return { updated: 0 };
  const amountCond = input.amount === null ? "" : "AND amount = ?";
  // 상세 메모만 있는 건(첫 줄이 비어 '\n…')은 앞에 붙여서 상세를 살린다
  const binds: SqlValue[] = [memo, memo, input.merchant, ...(input.amount === null ? [] : [input.amount])];
  const statements = [
    db
      .prepare(
        `UPDATE ledger_transactions
         SET memo = CASE WHEN memo IS NULL OR memo = '' THEN ? ELSE ? || memo END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE merchant = ? ${amountCond} AND status = 'active'
           AND (memo IS NULL OR memo = '' OR substr(memo, 1, 1) = char(10))`,
      )
      .bind(...binds),
  ];
  if (input.remember && input.amount !== null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ledger_settings (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .bind(memoRuleKey(input.merchant, input.amount), memo),
    );
  }
  const [result] = await db.batch(statements);
  forgetMemoUses();
  return { updated: result!.meta.changes };
}

/** 가져오기용: 저장된 메모 규칙 (가게·금액 → 메모) */
export async function loadMemoRules(db: SqlDb): Promise<Map<string, string>> {
  const rows = (await db.prepare("SELECT key, value FROM ledger_settings WHERE key LIKE 'memo.rule.%'").all<{ key: string; value: string }>()).results;
  return new Map(rows.map((r) => [r.key, r.value]));
}

/* ── 카테고리도 같은 결제에 한 번에 ─────────────────────────────── */

export const categoryRuleKey = (merchant: string, amount: number) => `category.rule.${amount}.${merchant}`;

/** 사용자가 직접 고르지 않은(자동 분류·미분류) 같은 가게 결제 중 카테고리가 다른 것 수 */
export async function similarCategory(db: SqlDb, merchant: string, amount: number, categoryId: number): Promise<{ sameAmount: number; sameMerchant: number }> {
  const row = await db
    .prepare(
      `SELECT count(*) AS merchant, ifnull(sum(amount = ?), 0) AS amount FROM ledger_transactions
       WHERE merchant = ? AND status = 'active' AND kind <> 'transfer'
         AND category_id IS NOT ? AND (category_source IS NULL OR category_source <> 'manual')`,
    )
    .bind(amount, merchant, categoryId)
    .first<{ merchant: number; amount: number }>();
  return { sameAmount: row?.amount ?? 0, sameMerchant: row?.merchant ?? 0 };
}

/** 같은 가게(·같은 금액) 결제의 카테고리를 바꾼다. 사용자가 직접 고른 건 그대로. remember 면 다음 가져오기부터도 */
export async function applyCategory(
  db: SqlDb,
  input: { merchant: string; amount: number | null; categoryId: number; remember: boolean },
): Promise<{ updated: number }> {
  const amountCond = input.amount === null ? "" : "AND amount = ?";
  const statements = [
    db
      .prepare(
        `UPDATE ledger_transactions SET category_id = ?, category_source = 'manual', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE merchant = ? ${amountCond} AND status = 'active' AND kind <> 'transfer'
           AND category_id IS NOT ? AND (category_source IS NULL OR category_source <> 'manual')`,
      )
      .bind(input.categoryId, input.merchant, ...(input.amount === null ? [] : [input.amount]), input.categoryId),
  ];
  if (input.remember && input.amount !== null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ledger_settings (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .bind(categoryRuleKey(input.merchant, input.amount), String(input.categoryId)),
    );
  }
  const [result] = await db.batch(statements);
  return { updated: result!.meta.changes };
}

/** 가져오기용: 저장된 카테고리 규칙 (가게·금액 → 카테고리 id) */
export async function loadCategoryRules(db: SqlDb): Promise<Map<string, number>> {
  const rows = (await db.prepare("SELECT key, value FROM ledger_settings WHERE key LIKE 'category.rule.%'").all<{ key: string; value: string }>()).results;
  return new Map(rows.map((r) => [r.key, Number(r.value)]));
}
