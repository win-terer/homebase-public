import { json, type SqlDb } from "@homebase/db";
import { movePhotos, refsWithPhotos } from "@homebase/core/photos";
import { simplePayTwins, type PayRow } from "../importers/simple-pay.ts";

/**
 * **이미 들어와 있는** 간편결제 중복을 찾아 지운다.
 *
 * 가져오기 쪽은 앞으로 들어올 것만 막는다(`web/prepare-import.ts`). 그 규칙이 생기기 전에
 * 쌓인 줄은 그대로 남아 있으므로, 같은 잣대로 한 번 훑어 준다.
 *
 * 지우는 건 **간편결제 쪽**(카드와 짝이면)이거나 **충전금 쪽**(`카카오페이 머니` 처럼 같은 초에
 * 같은 금액으로 또 적힌 줄)이다 — 이유는 `importers/simple-pay.ts` 머리말 참고.
 */

export interface DupeRow {
  id: number;
  date: string;
  time: string | null;
  merchant: string;
  amount: number;
  paymentMethod: string | null;
}

export interface DupePair {
  /** 지울 줄 (간편결제 또는 충전금) */
  pay: DupeRow;
  /** 남길 줄 (카드 또는 결제 줄) */
  card: DupeRow;
}

/**
 * 간편결제·카드로 낸 것만 읽어 짝을 맞춘다. 통장·예금 줄은 처음부터 가져오지 않는다 —
 * 같은 날 같은 금액의 계좌 이체와 엮이면 엉뚱한 걸 지운다.
 */
export async function findSimplePayDupes(db: SqlDb): Promise<DupePair[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id, date, time, merchant, amount, payment_method AS paymentMethod
           FROM ledger_transactions
          WHERE kind <> 'transfer' AND payment_method IS NOT NULL
            AND (payment_method LIKE '%간편결제%' OR payment_method LIKE '%페이 머니%'
                 OR payment_method LIKE '%카드%' OR payment_method LIKE '%LOCA%' OR payment_method LIKE '%Edition%')
          ORDER BY date, time`,
      )
      .all<DupeRow>()
  ).results;
  return simplePayTwins(rows as (DupeRow & PayRow)[]).map(({ pay, card }) => ({ pay: rows[pay]!, card: rows[card]! }));
}

/**
 * 고른 줄을 지운다. **화면이 보낸 id 를 그대로 믿지 않는다** — 서버가 다시 찾아낸 짝과
 * 겹치는 것만 지운다. 미리보기와 지우기 사이에 데이터가 바뀌었어도 못 보던 줄이 날아가지 않는다.
 */
export async function removeSimplePayDupes(db: SqlDb, ids: number[]): Promise<{ removed: number }> {
  const pairs = await findSimplePayDupes(db);
  const twin = new Map(pairs.map((p) => [p.pay.id, p.card.id]));
  const sure = [...new Set(ids)].filter((id) => twin.has(id));
  if (!sure.length) return { removed: 0 };
  // 지우는 간편결제 줄에 붙인 사진은 남는 카드 줄로 옮긴다 (같은 결제다)
  // (사진 붙은 줄만 — 보통 0~몇 줄이라 줄마다 한 번씩 옮겨도 쿼리 수가 늘지 않는다)
  for (const ref of await refsWithPhotos(db, "ledger", sure)) await movePhotos(db, "ledger", ref, twin.get(Number(ref))!);
  const res = await db.prepare("DELETE FROM ledger_transactions WHERE id IN (SELECT value FROM json_each(?))").bind(json(sure)).run();
  return { removed: res.meta.changes };
}
