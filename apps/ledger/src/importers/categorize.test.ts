import { describe, expect, it } from "vitest";
import { categorize, isWorkLunch, mapExistingCategory } from "./categorize.ts";

const exp = (merchant: string, source?: { major: string; minor?: string }, date = "2026-09-15", time: string | null = "19:00:00") =>
  categorize({ kind: "expense", date, time, merchant, sourceCategory: source ?? null });

describe("categorize", () => {
  it("splits meals into work lunch and eating out", () => {
    expect(isWorkLunch("2026-09-15", "12:10:00")).toBe(true); // 화요일
    expect(isWorkLunch("2026-09-19", "12:10:00")).toBe(false); // 토요일
    expect(isWorkLunch("2026-09-25", "12:10:00")).toBe(false); // 추석
    expect(exp("가짜국밥", { major: "식비", minor: "한식" }, "2026-09-15", "12:10:00")).toEqual({ major: "식비", minor: "중식" });
    expect(exp("가짜중국집", { major: "식비", minor: "중식" }, "2026-09-15", "19:00:00")).toEqual({ major: "식비", minor: "외식" });
    expect(exp("가짜배달", { major: "식비", minor: "배달" }, "2026-09-15", "12:10:00")).toEqual({ major: "식비", minor: "배달" });
  });

  it("maps Banksalad categories and fills uncategorized ones by merchant", () => {
    expect(exp("가짜", { major: "주거/통신", minor: "휴대폰" })).toEqual({ major: "통신/구독", minor: "휴대폰" });
    expect(exp("가짜", { major: "카페/간식", minor: "도넛/핫도그" })).toEqual({ major: "카페/간식", minor: "베이커리/디저트" });
    expect(exp("가짜약국", { major: "미분류", minor: "미분류" })).toEqual({ major: "의료/건강", minor: "약국" });
    expect(exp("쿠팡_와우멤버십", { major: "미분류" })).toEqual({ major: "통신/구독", minor: "구독" });
    expect(exp("쿠팡(쿠페이)", { major: "미분류" })).toEqual({ major: "쇼핑", minor: "온라인쇼핑" });
    expect(exp("시리즈", { major: "미분류" })).toEqual({ major: "문화/여가", minor: "웹툰/웹소설" });
    expect(exp("PAYCO자동결제", { major: "미분류" })).toBeNull();
    // 폰 알림은 뱅샐 분류가 아예 없다 — 가게 이름만으로
    expect(exp("가짜커피_0")).toEqual({ major: "카페/간식", minor: "커피/음료" });
    expect(exp("가짜PC카페")).toEqual({ major: "문화/여가", minor: "놀이" });
    expect(exp("가짜베이커리")).toEqual({ major: "카페/간식", minor: "베이커리/디저트" });
    // 뱅샐이 소분류까지 준 건 그쪽이 이긴다
    expect(exp("가짜커피", { major: "생활", minor: "편의점" })).toEqual({ major: "생활", minor: "편의점" });
    expect(exp("가짜", { major: "생활", minor: "미분류" })).toEqual({ major: "생활" });
    expect(categorize({ kind: "transfer", date: "2026-09-15", time: null, merchant: "x", sourceCategory: { major: "이체" } })).toBeNull();
  });

  it("sorts income", () => {
    const inc = (merchant: string, major: string) => categorize({ kind: "income", date: "2026-09-15", time: null, merchant, sourceCategory: { major } });
    expect(inc("가짜회사 급여", "급여")).toEqual({ major: "급여", minor: "급여" });
    expect(inc("출금 리워드", "미분류")).toEqual({ major: "금융수입", minor: "캐시백/리워드" });
    expect(inc("가짜앱", "앱테크")).toEqual({ major: "기타" });
  });

  it("moves categories the user picked", () => {
    expect(mapExistingCategory(null, "대출 이자")).toEqual({ major: "주거", minor: "대출 이자" });
    expect(mapExistingCategory(null, "보험")).toEqual({ major: "보험" });
    expect(mapExistingCategory("주거/통신", "관리비")).toEqual({ major: "주거", minor: "관리비" });
    expect(mapExistingCategory(null, "내가만든것")).toBeNull();
  });
});
