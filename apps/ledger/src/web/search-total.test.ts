import { describe, expect, it } from "vitest";
import { defaultUnit, periodSums } from "./search-total.ts";
import type { Transaction } from "./api.ts";

function tx(p: Partial<Transaction> & { id: number; amount: number; date: string }): Transaction {
  return {
    kind: "expense",
    time: "13:37:44",
    merchant: "시리즈",
    memo: null,
    note: null,
    paymentMethod: "네이버페이 간편결제",
    categoryId: 10,
    category: "웹툰/웹소설",
    categoryGroup: "문화/여가",
    settlesId: null,
    ...p,
  };
}

describe("검색 결과 기간별 합계", () => {
  it("달별로 나간 돈·들어온 돈·건수를 세고 최근 달부터 내놓는다", () => {
    const sums = periodSums(
      [
        tx({ id: 1, date: "2026-11-12", amount: -10000 }),
        tx({ id: 2, date: "2026-10-26", amount: -10000 }),
        tx({ id: 3, date: "2026-10-09", amount: -10000 }),
        tx({ id: 4, date: "2026-10-02", amount: 3000, kind: "income" }),
      ],
      "month",
    );
    expect(sums.map((s) => s.key)).toEqual(["2026-11", "2026-10"]);
    expect(sums[0]).toMatchObject({ label: "2026년 11월", count: 1, out: 10000, in: 0 });
    expect(sums[1]).toMatchObject({ label: "2026년 10월", count: 3, out: 20000, in: 3000 });
  });

  it("해별로도 묶는다", () => {
    const sums = periodSums([tx({ id: 1, date: "2026-01-02", amount: -5000 }), tx({ id: 2, date: "2025-12-31", amount: -3000 })], "year");
    expect(sums.map((s) => s.label)).toEqual(["2026년", "2025년"]);
    expect(sums[1]!.out).toBe(3000);
  });

  it("같은 달의 환불은 그 달 지출에서 빠진다", () => {
    const sums = periodSums([tx({ id: 1, date: "2026-11-12", amount: -10000 }), tx({ id: 2, date: "2026-11-14", amount: 4000 })], "month");
    expect(sums[0]!.out).toBe(6000);
  });

  it("달이 많으면 해별로 시작한다 (표가 결과 목록보다 길어지지 않게)", () => {
    const many = Array.from({ length: 16 }, (_, i) => tx({ id: i, date: `2026-${String((i % 12) + 1).padStart(2, "0")}-01`, amount: -1000 }));
    expect(defaultUnit(many.slice(0, 12))).toBe("month");
    expect(defaultUnit([...many, tx({ id: 99, date: "2024-01-01", amount: -1000 }), tx({ id: 98, date: "2024-02-01", amount: -1000 }), tx({ id: 97, date: "2024-03-01", amount: -1000 }), tx({ id: 96, date: "2024-04-01", amount: -1000 })])).toBe("year");
  });
});
