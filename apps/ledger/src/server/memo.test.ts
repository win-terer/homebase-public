import { describe, expect, it } from "vitest";
import { joinMemo, splitMemo } from "./memo.ts";

describe("memo + detail note in one column", () => {
  it("round-trips", () => {
    expect(joinMemo("장보기", "가짜 계란\n가짜 휴지")).toBe("장보기\n가짜 계란\n가짜 휴지");
    expect(splitMemo("장보기\n가짜 계란\n가짜 휴지")).toEqual({ memo: "장보기", note: "가짜 계란\n가짜 휴지" });
    expect(splitMemo(joinMemo(null, "가짜 계란"))).toEqual({ memo: null, note: "가짜 계란" });
    expect(joinMemo("  ", "  ")).toBeNull();
    expect(splitMemo("한 줄")).toEqual({ memo: "한 줄", note: null });
    expect(splitMemo(null)).toEqual({ memo: null, note: null });
  });
});
