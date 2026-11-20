import { describe, expect, it } from "vitest";
import { categoryFromTitle } from "./auto-category.ts";

const CATS = [
  { id: 1, name: "일정" },
  { id: 2, name: "반려" },
  { id: 3, name: "집" },
  { id: 4, name: "반려 병원" },
];

describe("제목으로 분류 짐작", () => {
  it("이름이 들어 있으면 그 분류", () => {
    expect(categoryFromTitle("반려 자동 급식기 첫사용", CATS)).toBe(2);
  });

  it("여럿이 걸리면 더 긴 이름이 이긴다", () => {
    expect(categoryFromTitle("반려 병원 예약", CATS)).toBe(4);
  });

  it("한 글자 이름은 거들지 않는다 (아무 데나 걸린다)", () => {
    expect(categoryFromTitle("집들이", CATS)).toBeNull();
  });

  it("걸리는 게 없거나 빈 제목이면 null", () => {
    expect(categoryFromTitle("치과", CATS)).toBeNull();
    expect(categoryFromTitle("   ", CATS)).toBeNull();
  });

  it("대소문자는 가리지 않는다", () => {
    expect(categoryFromTitle("GYM 가는 날", [{ id: 9, name: "gym" }])).toBe(9);
  });
});
