import { describe, expect, it } from "vitest";
import { mergeSplits, partLabel, splitSummary } from "./split-pay.ts";
import type { Transaction } from "./api.ts";

/** 가짜 거래 한 줄 */
function tx(p: Partial<Transaction> & { id: number; amount: number }): Transaction {
  return {
    kind: "expense",
    date: "2026-11-09",
    time: "13:37:44",
    merchant: "뽀숑하우스",
    memo: null,
    note: null,
    paymentMethod: "네이버페이 간편결제",
    categoryId: 10,
    category: "마트/생필품",
    categoryGroup: "생활",
    settlesId: null,
    ...p,
  };
}

describe("쪼개 들어온 결제 묶기", () => {
  it("같은 날·같은 초·같은 가게면 한 줄로 합친다", () => {
    const rows = mergeSplits([
      tx({ id: 1, amount: -1300, paymentMethod: "네이버페이 간편결제(포인트)" }),
      tx({ id: 2, amount: -14000, memo: "몽이 탈취제" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(-15300);
    // 메모가 달린 줄이 대표 — 달력에 사람이 적은 것이 보여야 한다
    expect(rows[0]!.id).toBe(2);
    expect(rows[0]!.memo).toBe("몽이 탈취제");
    expect(rows[0]!.splitParts).toEqual([
      { id: 2, amount: -14000, paymentMethod: "네이버페이 간편결제" },
      { id: 1, amount: -1300, paymentMethod: "네이버페이 간편결제(포인트)" },
    ]);
  });

  it("메모가 없으면 금액이 가장 큰 줄이 대표", () => {
    const rows = mergeSplits([tx({ id: 1, amount: -1715 }), tx({ id: 2, amount: -8785 }), tx({ id: 3, amount: -100 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(2);
    expect(rows[0]!.amount).toBe(-10600);
    expect(rows[0]!.splitParts).toHaveLength(3);
  });

  it("같은 초에 부호가 섞이면 그 자리 취소다 — 묶지 않는다", () => {
    const rows = mergeSplits([tx({ id: 1, amount: -20500 }), tx({ id: 2, amount: 20500 })]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.splitParts === undefined)).toBe(true);
  });

  it("시각이 1초라도 다르면 다른 결제", () => {
    const rows = mergeSplits([tx({ id: 1, amount: -1000 }), tx({ id: 2, amount: -2000, time: "13:37:45" })]);
    expect(rows).toHaveLength(2);
  });

  it("가게가 다르거나 시각이 없으면 묶지 않는다", () => {
    expect(mergeSplits([tx({ id: 1, amount: -1000 }), tx({ id: 2, amount: -2000, merchant: "다른가게" })])).toHaveLength(2);
    expect(mergeSplits([tx({ id: 1, amount: -1000, time: null }), tx({ id: 2, amount: -2000, time: null })])).toHaveLength(2);
  });

  it("묶는 기준은 **원래** 가게 이름 — 보여줄 이름이 같아도 원래가 다르면 다른 결제", () => {
    const rows = mergeSplits([
      tx({ id: 1, amount: -1000, rawMerchant: "한국철도공사" }),
      tx({ id: 2, amount: -2000, rawMerchant: "철도승차권발매" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("수입·이체는 건드리지 않는다", () => {
    const rows = mergeSplits([tx({ id: 1, amount: 1000, kind: "income" }), tx({ id: 2, amount: 2000, kind: "income" })]);
    expect(rows).toHaveLength(2);
  });

  it("묶을 게 없으면 받은 목록을 그대로 돌려준다 (쓸데없이 새 배열을 만들지 않는다)", () => {
    const list = [tx({ id: 1, amount: -1000 })];
    expect(mergeSplits(list)).toBe(list);
  });

  it("묶이지 않은 줄의 자리와 순서는 그대로", () => {
    const rows = mergeSplits([
      tx({ id: 9, amount: -500, time: "09:00:00" }),
      tx({ id: 1, amount: -1300 }),
      tx({ id: 2, amount: -14000 }),
      tx({ id: 8, amount: -700, time: "20:00:00" }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([9, 2, 8]);
  });
});

describe("구성 적기", () => {
  it("결제수단을 짧은 말로", () => {
    expect(partLabel("네이버페이 간편결제(포인트)")).toBe("포인트");
    expect(partLabel("네이버페이 간편결제(머니)")).toBe("머니");
    expect(partLabel("네이버페이 간편결제")).toBe("간편결제");
    expect(partLabel("카카오페이 머니")).toBe("머니");
    expect(partLabel("ONE")).toBe("ONE");
    expect(partLabel("가짜통장")).toBe("가짜통장");
    expect(partLabel(null)).toBe("결제");
  });

  it("포인트 1,300 + 간편결제 14,000", () => {
    expect(
      splitSummary([
        { id: 2, amount: -14000, paymentMethod: "네이버페이 간편결제" },
        { id: 1, amount: -1300, paymentMethod: "네이버페이 간편결제(포인트)" },
      ]),
    ).toBe("간편결제 14,000 + 포인트 1,300");
  });
});
