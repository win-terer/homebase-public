import { json, type SqlDb } from "@homebase/db";
import { ensureCategoryPath } from "./categories.ts";
import { counterpartyKey, kindForAction, type RuleAction } from "./transfer-rules.ts";

export interface ReviewGroup {
  /** 규칙 키 (뒤 숫자를 뗀 상대방 이름) */
  counterparty: string;
  /** 실제로 찍힌 이름들 */
  names: string[];
  count: number;
  /** 합계 (나간 돈 음수) */
  total: number;
  from: string;
  to: string;
  rows: { id: number; date: string; time: string | null; merchant: string; amount: number; paymentMethod: string | null }[];
}

/** 확인 필요한 이체를 상대방별로 묶는다. 건수가 많은 순 */
export async function listReviewGroups(db: SqlDb): Promise<ReviewGroup[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id, date, time, merchant, amount, payment_method AS paymentMethod
         FROM ledger_transactions WHERE status = 'review' ORDER BY date, time`,
      )
      .all<ReviewGroup["rows"][number]>()
  ).results;

  const groups = new Map<string, ReviewGroup>();
  for (const row of rows) {
    const key = counterpartyKey(row.merchant);
    const g = groups.get(key) ?? { counterparty: key, names: [], count: 0, total: 0, from: row.date, to: row.date, rows: [] };
    if (!g.names.includes(row.merchant)) g.names.push(row.merchant);
    g.count++;
    g.total += row.amount;
    g.to = row.date;
    g.rows.push(row);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || Math.abs(b.total) - Math.abs(a.total));
}

export interface ReviewDecision {
  counterparty: string;
  action: RuleAction;
  /** 지출·수입일 때 카테고리. 기존 id 또는 새로 만들 이름 ("대분류" 또는 "대분류 > 소분류") */
  categoryId?: number | null;
  newCategory?: string;
}

/**
 * 상대방 규칙을 저장하고, 지금 확인 필요로 남아 있는 그 상대방의 이체에 바로 적용한다.
 * 규칙은 다음 가져오기부터도 자동 적용된다.
 */
export async function decideReview(db: SqlDb, d: ReviewDecision): Promise<{ affected: number }> {
  const kind = kindForAction(d.action);
  let categoryId: number | null = null;
  if (kind === "expense" || kind === "income") {
    const name = d.newCategory?.trim();
    categoryId = name ? await ensureCategoryPath(db, name) : (d.categoryId ?? null);
  }

  const targets = (
    await db.prepare("SELECT id, merchant FROM ledger_transactions WHERE status = 'review'").all<{ id: number; merchant: string }>()
  ).results
    .filter((r) => counterpartyKey(r.merchant) === d.counterparty)
    .map((r) => r.id);

  await db.batch([
    db
      .prepare(
        `INSERT INTO ledger_transfer_rules (counterparty, action, category_id) VALUES (?, ?, ?)
         ON CONFLICT (counterparty) DO UPDATE SET action = excluded.action, category_id = excluded.category_id`,
      )
      .bind(d.counterparty, d.action, categoryId),
    kind
      ? db
          .prepare(
            `UPDATE ledger_transactions
             SET status = 'active', kind = ?, category_id = ?, category_source = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE id IN (SELECT value FROM json_each(?))`,
          )
          .bind(kind, categoryId, categoryId === null ? null : "rule", json(targets))
      : db.prepare("DELETE FROM ledger_transactions WHERE id IN (SELECT value FROM json_each(?))").bind(json(targets)),
  ]);
  return { affected: targets.length };
}
