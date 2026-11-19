import type { SqlDb } from "@homebase/db";
import type { TransactionKind } from "../importers/types.ts";

/** 확인 필요한 이체를 처리하는 방법 */
export type RuleAction = "exclude" | "transfer" | "expense" | "income";

export interface TransferRule {
  action: RuleAction;
  categoryId: number | null;
}

/**
 * 규칙·묶음에 쓰는 상대방 키. 매달 뒤 숫자가 바뀌는 이름(○○생명01000, ○○생명02000…)을
 * 하나로 묶으려고 끝의 숫자를 뗀다. 숫자만 있는 이름은 그대로 둔다.
 */
export function counterpartyKey(name: string): string {
  return name.replace(/\d+$/, "").trim() || name;
}

export async function loadTransferRules(db: SqlDb): Promise<Map<string, TransferRule>> {
  const rows = (
    await db
      .prepare("SELECT counterparty, action, category_id FROM ledger_transfer_rules")
      .all<{ counterparty: string; action: RuleAction; category_id: number | null }>()
  ).results;
  return new Map(rows.map((r) => [r.counterparty, { action: r.action, categoryId: r.category_id }]));
}

/** 규칙을 적용했을 때 거래의 종류. 제외는 null */
export function kindForAction(action: RuleAction): TransactionKind | null {
  return action === "exclude" ? null : action === "transfer" ? "transfer" : action;
}
