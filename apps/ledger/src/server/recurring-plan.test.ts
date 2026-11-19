import { describe, expect, it } from "vitest";
import { nextOccurrence, parsePlan, planToRecurring, type Plan } from "./recurring-plan.ts";

const plan = (p: Partial<Plan> = {}): Plan => ({
  name: "도메인 갱신",
  amount: 17_000,
  period: "year",
  startDate: "2027-09-02",
  direction: "out",
  categoryId: null,
  ...p,
});

describe("직접 등록한 정기 결제 — 읽기", () => {
  it("설정 한 줄을 읽는다", () => {
    const got = parsePlan("도메인 갱신", JSON.stringify({ amount: 17000, period: "year", startDate: "2027-09-02", direction: "out", categoryId: 3 }));
    expect(got).toEqual({ name: "도메인 갱신", amount: 17000, period: "year", startDate: "2027-09-02", direction: "out", categoryId: 3 });
  });

  it("모양이 깨졌으면 null — 그것만 빠지고 화면은 뜬다", () => {
    expect(parsePlan("x", "{{{")).toBeNull();
    expect(parsePlan("x", JSON.stringify({ amount: 1000, period: "decade", startDate: "2027-09-02" }))).toBeNull();
    expect(parsePlan("x", JSON.stringify({ amount: 1000, period: "year", startDate: "2027/09/02" }))).toBeNull();
    expect(parsePlan("x", JSON.stringify({ amount: 0, period: "year", startDate: "2027-09-02" }))).toBeNull();
    expect(parsePlan("", JSON.stringify({ amount: 1000, period: "year", startDate: "2027-09-02" }))).toBeNull();
  });

  it("음수로 적어도 양수로 본다 (나가는 돈은 direction 이 말해 준다)", () => {
    expect(parsePlan("x", JSON.stringify({ amount: -17000, period: "year", startDate: "2027-09-02" }))?.amount).toBe(17000);
  });
});

describe("직접 등록한 정기 결제 — 다음 결제일", () => {
  it("기준일이 아직 안 왔으면 그날 그대로", () => {
    expect(nextOccurrence(plan(), "2026-10-02")).toBe("2027-09-02");
  });

  it("지났으면 주기만큼 밀어 다음 날을 찾는다", () => {
    expect(nextOccurrence(plan(), "2027-09-03")).toBe("2028-09-02");
    expect(nextOccurrence(plan(), "2030-01-01")).toBe("2030-09-02");
  });

  it("당일은 아직 안 지난 것으로 본다", () => {
    expect(nextOccurrence(plan(), "2027-09-02")).toBe("2027-09-02");
  });

  it("31일에 등록하면 없는 달은 말일로 (그리고 다음 달에 31일로 돌아오지 않는다)", () => {
    const p = plan({ period: "month", startDate: "2026-01-31" });
    expect(nextOccurrence(p, "2026-02-01")).toBe("2026-02-28");
    expect(nextOccurrence(p, "2026-03-01")).toBe("2026-03-28");
  });

  it("윤년 2월 29일도 말일로 접힌다", () => {
    expect(nextOccurrence(plan({ startDate: "2028-02-29" }), "2028-03-01")).toBe("2029-02-28");
  });

  it("기준일이 아주 옛날이어도 끝난다", () => {
    expect(nextOccurrence(plan({ period: "week", startDate: "2020-01-01" }), "2026-10-02") >= "2026-10-02").toBe(true);
  });
});

describe("직접 등록한 정기 결제 — 정기 결제 한 줄로", () => {
  it("한 달 환산은 주기로 나눈다", () => {
    expect(planToRecurring(plan(), "2026-10-02", "k", null).monthly).toBe(Math.round(17_000 / 12));
    expect(planToRecurring(plan({ period: "month", amount: 9900 }), "2026-10-02", "k", null).monthly).toBe(9900);
  });

  it("안 나감으로 겁주지 않는다 (냈는지 알 길이 없다)", () => {
    const r = planToRecurring(plan(), "2030-01-01", "k", null);
    expect(r.missed).toBe(false);
    expect(r.count).toBe(0);
    expect(r.history).toEqual([]);
  });

  it("직접 등록 표시가 붙는다", () => {
    const r = planToRecurring(plan(), "2026-10-02", "k", null);
    expect(r.plan).toBe(true);
    expect(r.manual).toBe(true);
  });

  it("매년이면 결제일 자리에 월-일이 들어간다", () => {
    expect(planToRecurring(plan(), "2026-10-02", "k", null).anchor).toBe("09-02");
  });

  it("들어오는 돈으로도 등록된다", () => {
    const r = planToRecurring(plan({ direction: "in" }), "2026-10-02", "+k", null);
    expect(r.direction).toBe("in");
    expect(r.kind).toBe("income");
  });

  it("쉬는 날 당기기는 하지 않는다 (판단할 지난 기록이 없다)", () => {
    expect(planToRecurring(plan(), "2026-10-02", "k", null).shift).toBeNull();
  });
});
