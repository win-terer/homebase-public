import { describe, expect, it } from "vitest";
import type { Transaction } from "./api.ts";
import { classifyUsage, earnedIncomeCredit, estimateDeduction, estimateMortgageInterest, estimateRefund, guessPaymentType, incomeTax, isLongTermMortgage, yearEndProjection, type Usage } from "./tax.ts";

const usage = (p: Partial<Usage>): Usage => ({ credit: 0, debit: 0, culture: 0, market: 0, transit: 0, excluded: 0, none: 0, ...p });
const SALARY = 40_000_000; // 문턱 1,000만원

describe("guessPaymentType", () => {
  it("guesses from the payment method name", () => {
    expect(guessPaymentType("가짜카드 체크")).toBe("debit");
    expect(guessPaymentType("가짜카드ZERO")).toBe("credit");
    expect(guessPaymentType("LOCA 가짜카드")).toBe("credit");
    expect(guessPaymentType("가짜통장")).toBe("none");
    expect(guessPaymentType("네이버페이 간편결제(머니)")).toBe("none");
    expect(guessPaymentType("토스 간편결제")).toBe("none");
  });
});

describe("estimateDeduction", () => {
  it("gives nothing below the 25% threshold", () => {
    const e = estimateDeduction(usage({ credit: 8_000_000 }), SALARY);
    expect(e).toMatchObject({ threshold: 10_000_000, remainingToThreshold: 2_000_000, total: 0 });
    expect(e.per1m).toEqual({ credit: 0, debit: 0 });
  });

  it("uses up the threshold with credit card spending first", () => {
    // 신용 1,000만 = 문턱, 체크 200만 → 200만 × 30% = 60만
    expect(estimateDeduction(usage({ credit: 10_000_000, debit: 2_000_000 }), SALARY).total).toBe(600_000);
    // 신용 2,000만 → (2,000만 - 1,000만) × 15% = 150만
    const e = estimateDeduction(usage({ credit: 20_000_000 }), SALARY);
    expect(e).toMatchObject({ total: 1_500_000, remainingLimit: 1_500_000 });
    expect(e.per1m).toEqual({ credit: 150_000, debit: 300_000 });
  });

  it("caps at the basic limit and adds transit on top", () => {
    const e = estimateDeduction(usage({ credit: 40_000_000, transit: 1_000_000 }), SALARY);
    // 공제 가능: 4,000만×15% + 100만×40% - 1,000만×15% = 490만 → 기본 300만 + 추가 40만
    expect(e).toMatchObject({ general: 3_000_000, extra: 400_000, total: 3_400_000, remainingLimit: 0 });
    expect(e.per1m).toEqual({ credit: 0, debit: 0 });
  });

  it("uses lower limits above 70 million won", () => {
    expect(estimateDeduction(usage({ credit: 100_000_000 }), 80_000_000)).toMatchObject({ basicLimit: 2_500_000, total: 2_500_000 });
  });
});

describe("classifyUsage", () => {
  const tx = (merchant: string, amount: number, paymentMethod: string, category: string | null = null): Transaction => ({
    id: 0, kind: "expense", date: "2026-01-01", time: null, merchant, memo: null, note: null, amount, paymentMethod, categoryId: null, category, categoryGroup: null, settlesId: null,
  });
  it("splits spending by type and excludes bills", () => {
    const u = classifyUsage(
      [
        tx("가짜식당", -10000, "가짜신용"),
        tx("가짜식당", 2000, "가짜신용"), // 환불
        tx("가짜마트", -5000, "가짜 체크"),
        tx("가짜통신요금 자동납부", -50000, "가짜신용"),
        tx("가짜아파트", -100000, "가짜신용", "관리비"),
        tx("모바일티머니", -30000, "가짜신용"),
        tx("가짜가게", -7000, "가짜통장"),
      ],
      guessPaymentType,
      SALARY,
    );
    expect(u).toEqual({ credit: 8000, debit: 5000, culture: 0, market: 0, transit: 30000, excluded: 150000, none: 7000 });
  });
});

describe("estimateRefund", () => {
  const base = { salary: 40_000_000, withheldMonthly: 150_000, dependents: 0, cardDeduction: 2_000_000, mortgageInterest: 0, insurance: 0 };

  it("follows the standard steps", () => {
    const e = estimateRefund(base);
    expect(e.earnedDeduction).toBe(11_250_000); // 750만 + (4,000만-1,500만)×15%
    expect(e.deductions.basic).toBe(1_500_000);
    expect(e.calc).toBe(Math.round(840_000 + (e.base - 14_000_000) * 0.15));
    expect(e.credits.standard).toBe(130_000);
    expect(e.refund).toBe(Math.round((1_800_000 - e.determined) * 1.1));
  });

  it("drops the standard credit when claiming mortgage interest", () => {
    const e = estimateRefund({ ...base, mortgageInterest: 5_000_000, insurance: 800_000 });
    expect(e.deductions.mortgage).toBe(5_000_000);
    expect(e.credits).toMatchObject({ standard: 0, insurance: 96_000 });
    expect(e.refund).toBeGreaterThan(estimateRefund(base).refund);
  });

  it("caps mortgage interest and never makes the determined tax negative", () => {
    const e = estimateRefund({ ...base, salary: 30_000_000, mortgageInterest: 50_000_000 });
    expect(e.deductions.mortgage).toBe(18_000_000);
    expect(e.determined).toBe(0);
  });

  it("uses the income tax brackets and earned income credit limits", () => {
    expect(incomeTax(14_000_000)).toBe(840_000);
    expect(incomeTax(50_000_000)).toBe(6_240_000);
    expect(earnedIncomeCredit(3_000_000, 50_000_000)).toBe(660_000);
  });
});

describe("estimateMortgageInterest", () => {
  it("counts payments from the month after the loan starts", () => {
    const loan = { balance: 120_000_000, rate: 3, start: "2026-02-27", end: "2056-02-27" };
    expect(estimateMortgageInterest(loan, "2026")).toBe(3_000_000); // 월 30만 × 10회 (3~12월)
    expect(estimateMortgageInterest(loan, "2027")).toBe(3_600_000);
    expect(estimateMortgageInterest(loan, "2025")).toBe(0);
    expect(isLongTermMortgage(loan)).toBe(true);
    expect(isLongTermMortgage({ start: "2026-01-01", end: "2031-01-01" })).toBe(false);
  });
});

describe("yearEndProjection", () => {
  it("repeats the last 91 days over the rest of the year", () => {
    const p = yearEndProjection("2026", "2026-09-30");
    expect(p.recentFrom).toBe("2026-07-02");
    expect(p.remainingRatio).toBeCloseTo(92 / 91);
    expect(p.elapsedRatio).toBeCloseTo(92 / 273);
  });

  it("adds nothing for a finished year and uses the year so far early on", () => {
    expect(yearEndProjection("2025", "2026-09-30").remainingRatio).toBe(0);
    expect(yearEndProjection("2026", "2026-01-10").recentFrom).toBe("2026-01-01");
    expect(yearEndProjection("2027", "2026-09-30")).toMatchObject({ remainingRatio: 0, elapsedRatio: 0 });
  });
});
