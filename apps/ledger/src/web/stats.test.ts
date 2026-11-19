import { describe, expect, it } from "vitest";
import type { Transaction } from "./api.ts";
import { byCategory, hasFullCoverage, makePeriod, recentPeriods, shortLabel, spendByPeriod, summarize, topMerchants, topMerchantsByAmount, trend, weekdayTimeGrid, expensesInGroup, expensesOutside, groupSpend, sortTxs, txsInCell, txsInBucket } from "./stats.ts";

let id = 0;
const tx = (p: Partial<Transaction> & Pick<Transaction, "kind" | "date" | "amount">): Transaction => ({
  id: ++id,
  time: null,
  merchant: "가짜",
  memo: null,
  note: null,
  paymentMethod: null, categoryId: null,
  category: null,
  categoryGroup: null,
  settlesId: null,
  ...p,
});

describe("makePeriod", () => {
  it("builds Monday-start weeks, months and years", () => {
    expect(makePeriod("week", "2026-09-30")).toMatchObject({ from: "2026-09-28", to: "2026-10-04", prevAt: "2026-09-21" });
    expect(makePeriod("month", "2026-02")).toMatchObject({ from: "2026-02-01", to: "2026-02-28", prevAt: "2026-01", nextAt: "2026-03" });
    expect(makePeriod("month", "2026-01")).toMatchObject({ prevAt: "2025-12" });
    expect(makePeriod("year", "2026")).toMatchObject({ from: "2026-01-01", to: "2026-12-31", label: "2026년" });
  });
});

describe("hasFullCoverage", () => {
  it("requires data from the start of the period", () => {
    const year = makePeriod("year", "2025");
    expect(hasFullCoverage([tx({ kind: "expense", date: "2025-10-01", amount: -1 })], year)).toBe(false);
    expect(hasFullCoverage([tx({ kind: "expense", date: "2025-01-20", amount: -1 })], year)).toBe(true);
    expect(hasFullCoverage([], year)).toBe(false);
  });
});

describe("summaries", () => {
  const txs = [
    tx({ kind: "expense", date: "2026-09-01", time: "12:30:00", amount: -10000, merchant: "가짜식당", categoryGroup: "식비" }),
    tx({ kind: "expense", date: "2026-09-02", time: "12:10:00", amount: -20000, merchant: "가짜식당", categoryGroup: "식비" }),
    tx({ kind: "expense", date: "2026-09-02", time: "19:00:00", amount: -5000, merchant: "가짜카페", categoryGroup: "카페" }),
    tx({ kind: "expense", date: "2026-09-03", amount: 5000, merchant: "가짜카페", categoryGroup: "카페" }),
    tx({ kind: "income", date: "2026-09-25", amount: 3000000 }),
    tx({ kind: "income", date: "2026-09-26", amount: 7 }),
    tx({ kind: "transfer", date: "2026-09-10", amount: -100000 }),
  ];
  const period = makePeriod("month", "2026-09");

  it("summarizes spend net of refunds, income and daily average so far", () => {
    expect(summarize(txs, period, "2026-09-10")).toEqual({
      spend: 30000,
      income: 3000007,
      net: 2970007,
      count: 3,
      dailyAvg: 3000,
      smallIncome: { count: 1, total: 7 },
    });
  });

  it("buckets spend by day", () => {
    const days = trend(txs, period);
    expect(days).toHaveLength(30);
    expect(days.slice(0, 3).map((d) => d.spend)).toEqual([10000, 25000, -5000]);
    expect(trend(txs, makePeriod("year", "2026"))[8]).toMatchObject({ label: "9월", spend: 30000, income: 3000007 });
  });

  it("ranks categories and merchants", () => {
    expect(byCategory(txs)).toEqual([{ label: "식비", value: 30000, count: 2, share: 1 }]);
    expect(topMerchants(txs).map((m) => [m.label, m.count])).toEqual([
      ["가짜식당", 2],
      ["가짜카페", 1],
    ]);
    // 가짜카페는 5,000원 결제 후 5,000원 환불 → 쓴 돈 0원이라 금액 순위에서 빠진다
    expect(topMerchantsByAmount(txs).map((m) => [m.label, m.value])).toEqual([["가짜식당", 30000]]);
  });

  it("folds categories beyond the limit into 기타", () => {
    const many = ["a", "b", "c"].map((c, i) => tx({ kind: "expense", date: "2026-09-01", amount: -(3 - i) * 100, categoryGroup: c }));
    expect(byCategory(many, 2).map((r) => r.label)).toEqual(["a", "b", "기타"]);
  });

  it("counts visits by weekday and 3-hour slot", () => {
    const grid = weekdayTimeGrid(txs);
    expect(grid[1]![4]).toEqual({ count: 1, spend: 10000 }); // 9/1 화 12시
    expect(grid[2]![4]).toEqual({ count: 1, spend: 20000 }); // 9/2 수 12시
    expect(grid[2]![6]).toEqual({ count: 1, spend: 5000 }); // 9/2 수 19시
  });

  it("leaves automatic fixed costs out of the weekday×time pattern", () => {
    const grid = weekdayTimeGrid([
      tx({ kind: "expense", date: "2026-09-01", time: "00:10:00", amount: -15000, categoryGroup: "통신/구독" }),
      tx({ kind: "expense", date: "2026-09-01", time: "00:20:00", amount: -60000, categoryGroup: "보험" }),
      tx({ kind: "expense", date: "2026-09-01", time: "01:00:00", amount: -9000, categoryGroup: "식비" }),
    ]);
    expect(grid[1]![0]).toEqual({ count: 1, spend: 9000 });
  });
});

describe("recentPeriods", () => {
  it("lists the last n periods oldest first with short labels", () => {
    const months = recentPeriods("month", "2026-02", 3);
    expect(months.map(shortLabel)).toEqual(["12월", "1월", "2월"]);
    expect(recentPeriods("week", "2026-09-30", 2).map(shortLabel)).toEqual(["9/21", "9/28"]);
    const txs = [tx({ kind: "expense", date: "2026-01-15", amount: -1000 }), tx({ kind: "expense", date: "2026-02-01", amount: -500 })];
    expect(spendByPeriod(txs, months)).toEqual([0, 1000, 500]);
  });
});

describe("drill-down", () => {
  const list = [
    tx({ kind: "expense", date: "2026-09-04", time: "12:10:00", amount: -9000, categoryGroup: "식비", category: "중식", merchant: "가짜식당" }),
    tx({ kind: "expense", date: "2026-09-04", time: "12:40:00", amount: -30000, categoryGroup: "식비", category: "외식", merchant: "가짜식당" }),
    tx({ kind: "expense", date: "2026-09-05", time: "00:10:00", amount: -15000, categoryGroup: "통신/구독", category: "구독" }),
    tx({ kind: "expense", date: "2026-09-05", time: null, amount: -5000, categoryGroup: null }),
    tx({ kind: "income", date: "2026-09-04", time: null, amount: 100000, categoryGroup: "급여" }),
    tx({ kind: "transfer", date: "2026-09-04", time: null, amount: -50000 }),
  ];

  it("filters what each chart shows", () => {
    expect(expensesInGroup(list, "식비")).toHaveLength(2);
    expect(expensesInGroup(list, "미분류")).toHaveLength(1);
    expect(expensesOutside(list, ["식비"]).map((t) => t.categoryGroup)).toEqual(["통신/구독", null]);
    // 2026-09-04 는 금요일(4), 12~15시(4). 고정비는 빠진다
    expect(txsInCell(list, 4, 4)).toHaveLength(2);
    expect(txsInCell(list, 5, 0)).toHaveLength(0);
    // 막대 하루: 지출·수입만 (이체 제외)
    expect(txsInBucket(list, makePeriod("month", "2026-09"), "2026-09-04").map((t) => t.kind)).toEqual(["expense", "expense", "income"]);
  });

  it("groups and sorts the list", () => {
    expect(groupSpend(expensesInGroup(list, "식비"), (t) => t.category ?? "").map((g) => [g.label, g.value, g.share])).toEqual([
      ["외식", 30000, 1],
      ["중식", 9000, 0.3],
    ]);
    expect(sortTxs(list.slice(0, 3), "recent").map((t) => t.amount)).toEqual([-15000, -30000, -9000]);
    expect(sortTxs(list.slice(0, 3), "amount").map((t) => t.amount)).toEqual([-30000, -15000, -9000]);
  });
});
