import { describe, expect, it } from "vitest";
import { cancelsOf, countedRows, daySpending, shownRows } from "./day-view.ts";
import { spendOf, type Transaction } from "./api.ts";

const tx = (id: number, date: string, time: string | null, merchant: string, amount: number, kind: Transaction["kind"] = "expense"): Transaction =>
  ({ id, kind, date, time, merchant, memo: null, note: null, amount, paymentMethod: "가짜카드", categoryId: null, category: null, categoryGroup: null, settlesId: null }) as Transaction;

describe("가계부 달력과 일정 달력이 같은 규칙을 쓴다", () => {
  // 10/1 에 한 번 긁고 10/3 에 반씩 두 번 돌려받은 모양 (카드 환불은 이렇게 쪼개져 들어오기도 한다)
  const list = [
    tx(1, "2026-10-01", "13:34", "한국철도공사", -38800),
    tx(2, "2026-10-03", null, "한국철도공사", 19400),
    tx(3, "2026-10-03", null, "한국철도공사", 19400),
    tx(4, "2026-10-01", "09:00", "백다방", -3700),
  ];
  const cancels = cancelsOf(list);

  it("환불 줄은 숨기고 원래 결제는 남긴다 (취소선용)", () => {
    expect(shownRows(list, cancels).map((t) => t.id)).toEqual([1, 4]);
    expect([...cancels.cancelled]).toEqual([1]);
  });

  it("합계에서는 취소된 짝을 둘 다 뺀다 — 백다방만 남는다", () => {
    expect(spendOf(countedRows(list, cancels))).toBe(3700);
  });

  it("일정 달력의 하루 목록도 같은 결과", () => {
    const byDate = new Map<string, Transaction[]>();
    for (const t of list) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
    expect(daySpending(byDate, "2026-10-01", cancels).map((t) => t.id)).toEqual([4, 1]);
    expect(daySpending(byDate, "2026-10-03", cancels)).toEqual([]); // 환불 두 줄은 숨는다
  });

  it("이체는 일정 달력에서 뺀다 (카드값·계좌 옮김은 그날의 일이 아니다)", () => {
    const withTransfer = [...list, tx(5, "2026-10-01", "10:00", "카드대금", -500000, "transfer")];
    const byDate = new Map([["2026-10-01", withTransfer.filter((t) => t.date === "2026-10-01")]]);
    expect(daySpending(byDate, "2026-10-01", cancelsOf(withTransfer)).map((t) => t.id)).toEqual([4, 1]);
  });
});
