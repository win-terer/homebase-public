import { describe, expect, it } from "vitest";
import { suggestMemos, type MemoUse } from "./memo-suggest.ts";

const use = (memo: string, merchant: string, amount: number, count = 1): MemoUse => ({ memo, merchant, amount, count, last: "2026-09-30" });
const USES = [
  use("가짜카페", "가짜결제_카드", -3700, 2),
  use("가짜분식", "가짜결제_카드", -9900, 1),
  use("점심 회식", "가짜식당", -40000, 9),
  use("가짜카페", "다른가게", -4500, 1),
];

describe("suggestMemos", () => {
  it("puts the same merchant and amount first", () => {
    expect(suggestMemos(USES, { merchant: "가짜결제_카드", amount: -3700 }, "")).toEqual(["가짜카페", "가짜분식", "점심 회식"]);
    expect(suggestMemos(USES, { merchant: "새가게", amount: -100 }, "")[0]).toBe("점심 회식");
  });

  it("filters by typed text and choseong", () => {
    expect(suggestMemos(USES, { merchant: "새가게", amount: -100 }, "카페")).toEqual(["가짜카페"]);
    expect(suggestMemos(USES, { merchant: "새가게", amount: -100 }, "ㅈㅅ")).toEqual(["점심 회식"]);
    expect(suggestMemos(USES, { merchant: "새가게", amount: -100 }, "가짜카페")).toEqual([]); // 이미 다 친 건 빼고
  });
});
