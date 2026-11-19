import { describe, expect, it } from "vitest";
import { suggestSearch, type SearchTerms } from "./search-suggest.ts";

const terms: SearchTerms = {
  merchants: [
    { text: "가짜마트 역삼점", n: 3 },
    { text: "가짜_멤버십", n: 12 },
    { text: "진짜카페", n: 40 },
  ],
  memos: [{ text: "가짜 점심", n: 5 }],
  categories: ["식비", "구독", "가짜분류"],
};

describe("suggestSearch", () => {
  it("fills the last word from shops, categories and memos, prefix matches first, then by count", () => {
    const s = suggestSearch(terms, "가짜");
    expect(s[0]).toMatchObject({ kind: "카테고리", text: "가짜분류" });
    expect(s.map((x) => x.text)).toEqual(["가짜분류", "가짜_멤버십", "가짜 점심", "가짜마트 역삼점"]);
  });

  it("keeps earlier words (AND search) and matches 초성", () => {
    const s = suggestSearch(terms, "구독 ㄱㅉㅁ");
    expect(s[0]).toEqual({ kind: "가게", text: "가짜_멤버십", query: "구독 가짜_멤버십" });
  });

  it("skips amounts, empty words and terms already typed", () => {
    expect(suggestSearch(terms, "7890")).toEqual([]);
    expect(suggestSearch(terms, "식비 ")).toEqual([]);
    expect(suggestSearch(terms, "식비 식").map((x) => x.text)).not.toContain("식비");
  });
});
