import { describe, expect, it } from "vitest";
import { monthGrid, shiftDays } from "./dates.ts";

describe("shiftDays", () => {
  it("달을 넘어간다", () => {
    expect(shiftDays("2026-10-01", -7)).toBe("2026-09-24");
    expect(shiftDays("2026-10-31", 1)).toBe("2026-11-01");
  });
  it("해를 넘어간다", () => {
    expect(shiftDays("2027-01-01", -1)).toBe("2026-12-31");
  });
  it("윤달", () => {
    expect(shiftDays("2028-03-01", -1)).toBe("2028-02-29");
  });
  it("달력 왼쪽 끝보다 앞을 가리킨다 — 취소 짝을 맞추려고 더 받는 범위", () => {
    const days = monthGrid("2026-10");
    expect(shiftDays(days[0]!, -7) < days[0]!).toBe(true);
  });
});
