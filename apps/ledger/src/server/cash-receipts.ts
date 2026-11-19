import { json, type SqlDb } from "@homebase/db";
import type { CashReceipt } from "../importers/cash-receipt-csv.ts";
import { guessPaymentType, type PaymentType } from "../web/tax.ts";
import { merchantKey } from "./merchants.ts";

/** 현금영수증 연결·저장 (서버). CSV 는 브라우저에서 읽어 영수증 목록만 받는다 */

export type ReceiptOutcome = "duplicate" | "existing" | "added" | "cancelled";

export interface PlannedReceipt {
  receipt: CashReceipt;
  outcome: ReceiptOutcome;
  /** existing 일 때 연결할 거래 */
  match?: { id: number; date: string; merchant: string; paymentMethod: string | null };
}

const DAY = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const diff = (a: string, b: string) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;

/**
 * 현금영수증 가맹점과 실제 결제 이름이 다른데 같은 곳인 경우 (사용자 확인).
 * 현금영수증 가맹점 키 → 결제 이름에 들어 있는 말. 표시 이름은 바꾸지 않고 연결에만 쓴다.
 */
const RECEIPT_PAYEE_ALIASES: Record<string, string[]> = {
  // 홈택스에 찍힌 상호와 카드 내역의 이름이 달라 안 묶이면 여기에 더한다.
  // 예) 법인명과 브랜드명이 다른 곳: "○○협동조합": ["○○브랜드"]
};

/** 같은 곳으로 볼 이름: 키가 같거나, 한쪽이 다른 쪽으로 시작 (잘려서 찍힌 이름, 4글자 이상), 또는 확인된 별칭 */
function sameMerchant(receiptName: string, payee: string): boolean {
  const [x, y] = [merchantKey(receiptName), merchantKey(payee)];
  if (x === y) return true;
  if (RECEIPT_PAYEE_ALIASES[x]?.some((alias) => y.includes(merchantKey(alias)))) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * 결제일이 현금영수증 발급일보다 며칠 전(before)~며칠 후(after)까지 같은 결제로 볼지.
 * - 이름이 같은 곳: 온라인 구매는 구매확정 때 발급돼서 결제가 먼저(최대 약 3주), 렌탈료는 발급 후 약 3주 뒤 자동이체
 * - 쇼핑 플랫폼(토스쇼핑·카카오·네이버페이): 결제는 플랫폼 이름, 현금영수증은 판매자 이름이라 이름이 달라도 구매확정 기간만큼 본다
 * - 그 밖의 다른 이름: 결제대행사 이름으로 찍힌 경우만 ±3일
 */
const WINDOW = {
  sameName: { before: 20, after: 25 },
  platform: { before: 20, after: 3 },
  otherName: { before: 3, after: 3 },
};
/** 판매자 대신 플랫폼 이름으로 결제가 찍히는 곳 (실제 내보내기에서 확인한 이름) */
const SHOPPING_PLATFORM = /^(토스쇼핑|주식회사 카카오|카카오|네이버페이)$/;

/**
 * 받은 현금영수증을 기존 거래와 맞춘다. DB 는 바꾸지 않는다.
 * 현금영수증은 계좌·간편결제에서 나오고 신용카드에서는 나오지 않는다. 간편결제는 결제대행사 이름
 * (토스페이먼츠, 페이레터 등)으로 찍혀서 이름이 달라도 날짜가 가까우면 같은 결제로 본다.
 * 발급일과 출금일이 다른 경우(렌탈료, 중개수수료 등)는 이름이 같을 때만 넓은 기간을 본다.
 */
export async function planCashReceipts(db: SqlDb, receipts: CashReceipt[]): Promise<PlannedReceipt[]> {
  if (!receipts.length) return [];
  const settings = new Map(
    (await db.prepare("SELECT key, value FROM ledger_settings WHERE key LIKE 'payment.%'").all<{ key: string; value: string }>()).results.map(
      (r) => [r.key.slice("payment.".length), r.value as PaymentType],
    ),
  );
  const typeOf = (method: string | null) => (method ? (settings.get(method) ?? guessPaymentType(method)) : "none");

  // 쿼리 수를 줄이려고 이미 받은 승인번호와 후보 거래(금액이 같고 기간 안)를 한 번에 가져온다
  const known = new Set(
    (
      await db
        .prepare("SELECT approval_no AS n FROM ledger_cash_receipts WHERE approval_no IN (SELECT value FROM json_each(?))")
        .bind(json(receipts.map((r) => r.approvalNo)))
        .all<{ n: string }>()
    ).results.map((r) => r.n),
  );
  const dates = receipts.map((r) => r.date).sort();
  type Candidate = { id: number; date: string; merchant: string; paymentMethod: string | null; amount: number };
  const pool = (
    await db
      .prepare(
        `SELECT id, date, merchant, payment_method AS paymentMethod, amount FROM ledger_transactions
         WHERE date BETWEEN ? AND ? AND amount IN (SELECT value FROM json_each(?))
           AND id NOT IN (SELECT transaction_id FROM ledger_cash_receipts WHERE transaction_id IS NOT NULL)`,
      )
      .bind(shift(dates[0]!, -20), shift(dates[dates.length - 1]!, 25), json([...new Set(receipts.map((r) => -r.amount))]))
      .all<Candidate>()
  ).results;
  const used = new Set<number>();

  return receipts.map((receipt) => {
    if (known.has(receipt.approvalNo)) return { receipt, outcome: "duplicate" };
    if (receipt.amount < 0) return { receipt, outcome: "cancelled" };
    const found = pool
      .filter((c) => c.amount === -receipt.amount && !used.has(c.id) && typeOf(c.paymentMethod) !== "credit")
      .map((c) => ({ c, sameName: sameMerchant(receipt.merchant, c.merchant), gap: diff(c.date, receipt.date) }))
      .filter((m) => {
        const w = m.sameName ? WINDOW.sameName : SHOPPING_PLATFORM.test(m.c.merchant) ? WINDOW.platform : WINDOW.otherName;
        return m.gap >= -w.before && m.gap <= w.after;
      })
      .sort((a, b) => Number(b.sameName) - Number(a.sameName) || Math.abs(a.gap) - Math.abs(b.gap) || b.gap - a.gap)[0];
    if (!found) return { receipt, outcome: "added" };
    used.add(found.c.id);
    const { amount: _, ...match } = found.c;
    return { receipt, outcome: "existing", match };
  });
}

/** 계획대로 저장한다. 새 지출과 영수증을 한 트랜잭션(문장 2개)으로 넣는다 */
export async function commitCashReceipts(db: SqlDb, plan: PlannedReceipt[]): Promise<{ stored: number; added: number }> {
  const rows = plan
    .filter((p) => p.outcome !== "duplicate")
    .map(({ receipt: r, outcome, match }) => ({
      ...r,
      matched: outcome === "existing" ? "existing" : outcome === "added" ? "added" : "none",
      transactionId: match?.id ?? null,
      dedupeKey: `cash-receipt:${r.approvalNo}`,
    }));
  if (!rows.length) return { stored: 0, added: 0 };
  const data = json(rows);
  const [tx, receipts] = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO ledger_transactions (kind, status, date, time, merchant, amount, payment_method, source, dedupe_key)
         SELECT 'expense', 'active', j.value ->> 'date', j.value ->> 'time', j.value ->> 'merchant', -(j.value ->> 'amount'),
                '현금영수증', 'cash-receipt', j.value ->> 'dedupeKey'
         FROM json_each(?) j WHERE j.value ->> 'matched' = 'added'`,
      )
      .bind(data),
    db
      .prepare(
        `INSERT OR IGNORE INTO ledger_cash_receipts (approval_no, date, time, merchant, amount, kind, matched, transaction_id)
         SELECT j.value ->> 'approvalNo', j.value ->> 'date', j.value ->> 'time', j.value ->> 'merchant', j.value ->> 'amount',
                j.value ->> 'kind', j.value ->> 'matched',
                CASE j.value ->> 'matched'
                  WHEN 'existing' THEN j.value ->> 'transactionId'
                  WHEN 'added' THEN (SELECT id FROM ledger_transactions WHERE dedupe_key = j.value ->> 'dedupeKey')
                END
         FROM json_each(?) j`,
      )
      .bind(data),
  ]);
  return { stored: receipts!.meta.changes, added: tx!.meta.changes };
}

/** 연도별 현금영수증 합계 (연말정산 카드용) */
export async function cashReceiptSummary(db: SqlDb, year: string) {
  return (await db
    .prepare(
      `SELECT count(*) AS count, ifnull(sum(amount), 0) AS total,
              ifnull(sum(CASE WHEN kind = 'culture' THEN amount END), 0) AS culture
       FROM ledger_cash_receipts WHERE date BETWEEN ? AND ?`,
    )
    .bind(`${year}-01-01`, `${year}-12-31`)
    .first<{ count: number; total: number; culture: number }>())!;
}
