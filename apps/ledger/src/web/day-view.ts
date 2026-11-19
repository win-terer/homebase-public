import { pairCancels, splitSmallIncome, type Transaction } from "./api.ts";

/**
 * **하루치 거래를 화면에 그릴 모양으로.** 가계부 달력과 일정 달력이 같은 규칙을 쓰게 하는 한 곳.
 *
 * 전에는 가계부 쪽에만 규칙이 있어서, 같은 날을 두 화면에서 보면 달랐다 — 취소된 결제가
 * 가계부에서는 취소선 한 줄인데 일정에서는 결제와 환불 두 줄로 나왔다(사용자 지적 2026-10-06).
 * 규칙이 한 벌이면 그렇게 갈라질 일이 없다.
 *
 * 규칙은 셋이다:
 * - **취소된 짝**: 환불 줄은 숨기고 원래 결제에 취소선을 긋는다. 합계에서는 **둘 다** 뺀다
 *   (환불만 빼고 결제를 남기면 달이 틀어진다). 짝은 `pairCancels` 가 **보고 있는 기간 전체**로
 *   맞춘다 — 카드 취소는 이틀씩 밀려 들어오고, 쪼개져 들어오기도 한다.
 * - **소액 수입**(1,000원 미만 리워드·이자)은 달력에서 빼고 통계에서만 본다.
 * - 시간 순. 시각 없는 것은 뒤로.
 */

export interface DayCancels {
  /** 취소된 원래 결제 — 취소선을 긋는다 */
  cancelled: Set<number>;
  /** 그 취소로 들어온 환불 — 화면에서 숨긴다 */
  absorbed: Set<number>;
}

/** 보고 있는 기간 전체로 결제·환불 짝을 맞춘다. 화면마다 따로 맞추지 말 것 */
export function cancelsOf(txs: Transaction[]): DayCancels {
  return pairCancels(txs);
}

/** 화면에서 숨길 줄(환불)을 걷어낸다 */
export function shownRows(txs: Transaction[], cancels: DayCancels): Transaction[] {
  return txs.filter((t) => !cancels.absorbed.has(t.id));
}

/** 합계에 넣을 줄 — 취소된 짝은 **둘 다** 뺀다 */
export function countedRows(txs: Transaction[], cancels: DayCancels): Transaction[] {
  return txs.filter((t) => !cancels.absorbed.has(t.id) && !cancels.cancelled.has(t.id));
}

const byTime = (a: Transaction, b: Transaction) => (a.time ?? "99").localeCompare(b.time ?? "99");

/**
 * 하루치 — 일정 달력이 칸과 상세에 그리는 목록.
 *
 * 이체는 뺀다: 카드값·계좌 옮김이라 "그날 무엇을 했나" 와는 상관이 없다(가계부 달력은 보여
 * 주므로 거기서는 이 함수를 쓰지 않는다).
 */
export function daySpending(byDate: Map<string, Transaction[]>, date: string, cancels: DayCancels): Transaction[] {
  const list = (byDate.get(date) ?? []).filter((t) => t.kind !== "transfer");
  return shownRows(splitSmallIncome(list).main, cancels).sort(byTime);
}
