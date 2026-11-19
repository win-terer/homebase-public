import { describe, expect, it } from "vitest";
import { compactWon, hourLabel, manWon, flowOf, pairCancels, shortWon, splitSmallIncome, type Transaction, importChunks, mergeSummaries, type ImportSummary } from "./api.ts";

const tx = (id: number, kind: Transaction["kind"], amount: number): Transaction => ({
  id,
  kind,
  amount,
  date: "2026-09-01",
  time: null,
  merchant: "가짜",
  memo: null,
  note: null,
  paymentMethod: null, categoryId: null,
  category: null,
  categoryGroup: null,
  settlesId: null,
});

describe("splitSmallIncome", () => {
  it("groups only income under 1,000 won", () => {
    const { main, small, smallTotal } = splitSmallIncome([
      tx(1, "income", 4),
      tx(2, "income", 999),
      tx(3, "income", 1000),
      tx(4, "transfer", 500),
      tx(5, "expense", 300),
    ]);
    expect(small.map((t) => t.id)).toEqual([1, 2]);
    expect(smallTotal).toBe(1003);
    expect(main.map((t) => t.id)).toEqual([3, 4, 5]);
  });
});

describe("flowOf", () => {
  it("separates money in and out, refunds offsetting spend", () => {
    expect(flowOf([tx(1, "expense", -8900), tx(2, "income", 4)])).toEqual({ in: 4, out: 8900 });
    expect(flowOf([tx(1, "income", 3000000), tx(2, "transfer", -20000), tx(3, "expense", -8900)])).toEqual({
      in: 3000000,
      out: 28900,
    });
    expect(flowOf([tx(1, "expense", -10000), tx(2, "expense", 10000)])).toEqual({ in: 0, out: 0 });
    expect(flowOf([tx(1, "expense", 5000)])).toEqual({ in: 5000, out: 0 });
  });
});

describe("shortWon", () => {
  it("abbreviates amounts of 10,000 won or more", () => {
    expect(shortWon(3682846)).toBe("368.3만");
    expect(shortWon(52000)).toBe("5.2만");
    expect(shortWon(9500)).toBe("9,500");
  });
});

describe("hourLabel", () => {
  it("시만 남기고 앞 0 은 뗀다", () => {
    expect(hourLabel("07:48:00")).toBe("7시");
    expect(hourLabel("12:42")).toBe("12시");
    expect(hourLabel("00:05:10")).toBe("0시");
    expect(hourLabel("23:59:59")).toBe("23시");
  });
});

describe("manWon", () => {
  it("만 원 단위 소수 둘째 자리, 끝 0 은 뗀다", () => {
    expect(manWon(17500)).toBe("1.75");
    expect(manWon(450000)).toBe("45");
    expect(manWon(3700)).toBe("0.37");
    expect(manWon(2056)).toBe("0.21");
    expect(manWon(3682819)).toBe("368.28");
    expect(manWon(0)).toBe("0");
  });
});

describe("chunked imports", () => {
  const summary = (over: Partial<ImportSummary>): ImportSummary => ({
    source: { id: "s", label: "S" },
    period: null,
    total: 0,
    new: 0,
    newByKind: { expense: 0, income: 0, transfer: 0 },
    duplicates: 0,
    review: 0,
    excluded: {},
    skipped: [],
    ...over,
  });

  it("splits rows but always sends at least one request", () => {
    expect(importChunks([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(importChunks([], 2)).toEqual([[]]);
  });

  it("adds up the parts", () => {
    const a = summary({ total: 3, new: 2, newByKind: { expense: 2, income: 0, transfer: 0 }, excluded: { 내계좌이체: 1 }, period: { from: "2026-03-01", to: "2026-03-10" }, inserted: 2, batchId: 7 });
    const b = summary({ total: 2, new: 1, newByKind: { expense: 0, income: 1, transfer: 0 }, excluded: { 내계좌이체: 1, 카드대금: 1 }, period: { from: "2026-02-01", to: "2026-02-10" }, inserted: 1, batchId: 7 });
    expect(mergeSummaries(mergeSummaries(null, a), b)).toMatchObject({
      total: 5,
      new: 3,
      newByKind: { expense: 2, income: 1, transfer: 0 },
      excluded: { 내계좌이체: 2, 카드대금: 1 },
      period: { from: "2026-02-01", to: "2026-03-10" },
      inserted: 3,
      batchId: 7,
    });
  });
});

describe("compactWon", () => {
  it("shortens amounts for narrow cells", () => {
    expect(compactWon(12300)).toBe("1.2만");
    expect(compactWon(8900)).toBe("8.9천");
    expect(compactWon(500)).toBe("500");
  });
});

describe("pairCancels", () => {
  const at = (t: Transaction, time: string, merchant = "가짜"): Transaction => ({ ...t, time, merchant });
  it("pairs a same-day full refund with the closest earlier payment of the same shop and amount", () => {
    const list = [
      at(tx(1, "expense", -18000), "12:00:00"),
      at(tx(2, "expense", -18000), "17:32:00"),
      at(tx(3, "expense", 18000), "17:32:00"),
      at(tx(4, "expense", -36800), "17:54:00"),
    ];
    const { cancelled, absorbed } = pairCancels(list);
    expect([...cancelled]).toEqual([2]);
    expect([...absorbed]).toEqual([3]);
  });
  it("leaves partial refunds and other shops alone", () => {
    const list = [at(tx(1, "expense", -18000), "10:00:00"), at(tx(2, "expense", 5000), "11:00:00"), at(tx(3, "expense", 18000), "12:00:00", "다른가게")];
    const { cancelled, absorbed } = pairCancels(list);
    expect(cancelled.size + absorbed.size).toBe(0);
  });
});

describe("pairCancels — 며칠 걸쳐 들어온 취소", () => {
  const tx = (id: number, date: string, time: string | null, merchant: string, amount: number): Transaction =>
    ({ id, kind: "expense", date, time, merchant, memo: null, note: null, amount, paymentMethod: "가짜카드", categoryId: null, category: null, categoryGroup: null, settlesId: null }) as Transaction;

  it("10/1 결제 · 10/3 환불을 묶는다 (카드 취소는 밀려서 들어온다)", () => {
    const list = [tx(1, "2026-10-01", "13:34", "한국철도공사", -19400), tx(2, "2026-10-03", null, "한국철도공사", 19400)];
    const { cancelled, absorbed } = pairCancels(list);
    expect([...cancelled]).toEqual([1]);
    expect([...absorbed]).toEqual([2]);
  });

  it("같은 가게·같은 금액을 여러 번 결제했으면 먼저 쓴 것부터 짝이 된다", () => {
    const list = [
      tx(1, "2026-10-01", "09:36", "한국철도공사", -38800),
      tx(2, "2026-10-01", "13:34", "한국철도공사", -38800),
      tx(3, "2026-10-03", null, "한국철도공사", 38800),
    ];
    const { cancelled } = pairCancels(list);
    expect([...cancelled]).toEqual([2]); // 환불 직전의 결제
  });

  it("환불이 결제보다 앞서면 묶지 않는다", () => {
    const list = [tx(1, "2026-10-05", "09:00", "한국철도공사", -19400), tx(2, "2026-10-01", null, "한국철도공사", 19400)];
    expect([...pairCancels(list).cancelled]).toEqual([]);
  });

  it("너무 멀리 떨어지면 묶지 않는다", () => {
    const list = [tx(1, "2026-10-01", "09:00", "한국철도공사", -19400), tx(2, "2026-10-20", null, "한국철도공사", 19400)];
    expect([...pairCancels(list).cancelled]).toEqual([]);
  });
});

describe("pairCancels — 쪼개 들어온 환불", () => {
  const tx = (id: number, date: string, time: string | null, merchant: string, amount: number): Transaction =>
    ({ id, kind: "expense", date, time, merchant, memo: null, note: null, amount, paymentMethod: "가짜카드", categoryId: null, category: null, categoryGroup: null, settlesId: null }) as Transaction;

  it("결제 하나가 반씩 두 줄로 돌아온다 (둘이 끊고 한 명씩 환불)", () => {
    const list = [
      tx(1, "2026-10-01", "13:34", "한국철도공사", -38800),
      tx(2, "2026-10-03", null, "한국철도공사", 19400),
      tx(3, "2026-10-03", null, "한국철도공사", 19400),
    ];
    const { cancelled, absorbed } = pairCancels(list);
    expect([...cancelled]).toEqual([1]);
    expect([...absorbed].sort()).toEqual([2, 3]);
  });

  it("합이 안 맞으면 묶지 않는다", () => {
    const list = [
      tx(1, "2026-10-01", "13:34", "한국철도공사", -38800),
      tx(2, "2026-10-03", null, "한국철도공사", 19400),
    ];
    expect([...pairCancels(list).cancelled]).toEqual([]);
  });

  it("가게가 다르면 합쳐 보지 않는다", () => {
    const list = [
      tx(1, "2026-10-01", "13:34", "한국철도공사", -38800),
      tx(2, "2026-10-03", null, "스타벅스", 19400),
      tx(3, "2026-10-03", null, "스타벅스", 19400),
    ];
    expect([...pairCancels(list).cancelled]).toEqual([]);
  });

  it("금액이 같은 1:1 짝이 먼저다 (합치기는 남은 것만)", () => {
    const list = [
      tx(1, "2026-10-01", "09:00", "한국철도공사", -19400),
      tx(2, "2026-10-01", "13:34", "한국철도공사", -38800),
      tx(3, "2026-10-03", null, "한국철도공사", 19400),
    ];
    const { cancelled, absorbed } = pairCancels(list);
    expect([...cancelled]).toEqual([1]);
    expect([...absorbed]).toEqual([3]);
  });
});
