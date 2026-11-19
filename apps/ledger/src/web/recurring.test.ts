import { describe, expect, it } from "vitest";
import { dueDate, monthEntries, periodLabel, plannedByDate, plannedDates, type RecurringItem } from "./recurring.ts";

const item = (p: Partial<RecurringItem>): RecurringItem => ({
  key: "가짜", name: "가짜", kind: "expense", direction: "out", review: false, period: "month", anchor: "31", count: 3, lastDate: "2026-09-30",
  lastAmount: 1000, changedFrom: null, nextDate: "2026-10-31", missed: false, category: null, monthly: 1000, history: [], manual: false, plan: false,
  variable: false, expected: 1000, range: [1000, 1000], memo: null, aliases: [], ...p,
});

describe("recurring (web)", () => {
  it("labels and projects future dates", () => {
    expect(periodLabel(item({}))).toBe("매달 말일 전후");
    expect(periodLabel(item({ period: "week", anchor: "4" }))).toBe("매주 금요일");
    expect(periodLabel(item({ period: "bimonth" }))).toBe("2달마다 말일 전후");
    expect(plannedDates(item({ period: "bimonth", nextDate: "2026-11-30" }), "2026-10-01", "2027-04-01")).toEqual(["2026-11-30", "2027-01-31", "2027-03-31"]);
    expect(plannedDates(item({}), "2026-10-01", "2027-01-05")).toEqual(["2026-10-31", "2026-11-30", "2026-12-31"]);
    expect(plannedDates(item({ period: "week", anchor: "0", nextDate: "2026-10-05" }), "2026-10-06", "2026-10-20")).toEqual(["2026-10-12", "2026-10-19"]);
    const map = plannedByDate([item({ anchor: "25", nextDate: "2026-10-25" })], "2026-10-01", "2026-09-28", "2026-11-08");
    expect([...map.keys()]).toEqual(["2026-10-25"]);
  });
});

describe("monthEntries", () => {
  it("mixes paid history, planned and missed for a month", () => {
    const a = item({ key: "a", anchor: "5", nextDate: "2026-11-05", lastDate: "2026-10-05", history: [{ id: 1, date: "2026-10-05", amount: 1000 }], expected: 1000 });
    const b = item({ key: "b", anchor: "25", nextDate: "2026-10-25", history: [], expected: 2000 });
    const c = item({ key: "c", anchor: "2", nextDate: "2026-10-02", missed: true, history: [], expected: 3000 });
    const list = monthEntries([a, b, c], "2026-10", "2026-10-12");
    expect(list.map((e) => [e.item.key, e.date, e.state])).toEqual([
      ["c", "2026-10-02", "missed"],
      ["a", "2026-10-05", "paid"],
      ["b", "2026-10-25", "planned"],
    ]);
  });
});

describe("plannedDates safety", () => {
  it("steps irregular items by their usual gap", () => {
    expect(plannedDates(item({ anchor: "4", nextDate: "2026-10-04", irregular: true, gap: 36 }), "2026-10-01", "2026-12-31")).toEqual(["2026-10-04", "2026-11-09", "2026-12-15"]);
  });
  it("never repeats one day when the anchor is missing", () => {
    expect(plannedDates(item({ anchor: "", nextDate: "2026-10-04" }), "2026-10-01", "2026-12-31")).toEqual(["2026-10-04", "2026-11-04", "2026-12-04"]);
  });
});

describe("business days", () => {
  it("moves outgoing payments after weekends and holidays, income before", () => {
    const out = item({ anchor: "3", nextDate: "2026-10-03", shift: "after" });
    // 10/3 개천절(토) → 10/4 일 → 10/5 대체공휴일 → 10/6
    expect(plannedDates(out, "2026-10-01", "2026-11-30")).toEqual(["2026-10-06", "2026-11-03"]);
    const pay = item({ anchor: "25", nextDate: "2026-10-25", shift: "before", direction: "in" });
    expect(dueDate(pay, "2026-10-25")).toBe("2026-10-23");
    // shift 가 없으면 (카드 결제처럼 주말에도 나감) 그대로
    expect(dueDate(item({}), "2026-10-25")).toBe("2026-10-25");
  });
});
