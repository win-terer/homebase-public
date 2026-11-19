import { describe, expect, it } from "vitest";
import { actionsFor, suggestReview } from "./review-suggest.ts";

describe("suggestReview", () => {
  it("suggests from common words only", () => {
    expect(suggestReview("가짜생명", -60000)).toMatchObject({ action: "expense", category: "보험" });
    expect(suggestReview("주택금융공사", -600000)).toMatchObject({ action: "expense", category: "주거 > 대출 이자" });
    expect(suggestReview("가짜보증금반환", 1000000)).toMatchObject({ action: "transfer" });
    expect(suggestReview("적금 자동이체", -100000)).toMatchObject({ action: "exclude" });
    expect(suggestReview("2025년결산", 193)).toMatchObject({ action: "income", category: "금융수입 > 이자" });
    expect(suggestReview("가짜구지방소득", 1270)).toMatchObject({ action: "income", category: "기타" });
    expect(suggestReview("주식회사가짜인테", -1400000)).toMatchObject({ category: "주거 > 인테리어" });
  });

  it("leaves people and unknown names alone, but drops 1-won checks", () => {
    expect(suggestReview("간편이체(홍길동)", -100000)).toBeNull();
    expect(suggestReview("가짜회사", 500000)).toBeNull();
    expect(suggestReview("1234가짜카드", 1)).toMatchObject({ action: "exclude" });
    expect(suggestReview("가짜 선물 보상금", 8)).toMatchObject({ action: "income" }); // 이름 규칙이 먼저
  });
});

describe("actionsFor", () => {
  const labels = (amounts: number[]) => actionsFor(amounts).map((a) => a.label);
  it("offers only actions that fit the sign", () => {
    expect(labels([-30000, -1000])).toEqual(["지출", "이체로 기록", "제외"]);
    expect(labels([100000])).toEqual(["수입", "환불", "이체로 기록", "제외"]);
    expect(actionsFor([100000]).find((a) => a.label === "환불")?.value).toBe("expense");
    expect(labels([5000, -5000])).toEqual(["지출", "수입", "이체로 기록", "제외"]);
  });
});
