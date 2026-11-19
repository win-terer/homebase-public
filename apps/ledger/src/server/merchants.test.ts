import { describe, expect, it } from "vitest";
import { buildDisplayMap, displayMerchant, merchantKey } from "./merchants.ts";

describe("displayMerchant", () => {
  it("strips corporate markers so variants of one company match", () => {
    expect(displayMerchant("(주)가짜인테리어")).toBe("가짜인테리어");
    expect(displayMerchant("가짜인테리어")).toBe("가짜인테리어");
    expect(displayMerchant("주식회사 가짜상사")).toBe("가짜상사");
    expect(displayMerchant("㈜가짜상사")).toBe("가짜상사");
    expect(displayMerchant("가짜상사 주식회사")).toBe("가짜상사");
  });

  it("maps operating companies to the service name", () => {
    expect(displayMerchant("주식회사 버킷플레이스")).toBe("오늘의집");
    expect(displayMerchant("오늘의집")).toBe("오늘의집");
  });

  it("treats spacing and punctuation variants as the same place", () => {
    expect(merchantKey("가짜버거 가짜역점")).toBe(merchantKey("가짜버거가짜역점"));
    expect(merchantKey("가짜쇼핑_페이")).toBe(merchantKey("가짜쇼핑(페이)"));
    expect(merchantKey("씨유(CU)가짜점")).toBe(merchantKey("씨유CU가짜점"));
    expect(merchantKey("가짜버거")).not.toBe(merchantKey("가짜버거킹"));
  });

  it("shows the most used spelling for merged names", () => {
    const map = buildDisplayMap([
      { merchant: "가짜쇼핑_페이", n: 67 },
      { merchant: "가짜쇼핑(페이)", n: 26 },
      { merchant: "가짜버거 가짜역점", n: 2 },
      { merchant: "가짜버거가짜역점", n: 2 },
      { merchant: "(주)가짜인테리어", n: 1 },
      { merchant: "가짜인테리어", n: 5 },
    ]);
    expect(map.get("가짜쇼핑(페이)")).toBe("가짜쇼핑_페이");
    expect(map.get("가짜버거가짜역점")).toBe("가짜버거 가짜역점");
    expect(map.get("(주)가짜인테리어")).toBe("가짜인테리어");
  });

  it("leaves other names alone", () => {
    expect(displayMerchant("쿠팡이츠")).toBe("쿠팡이츠");
    expect(displayMerchant("(주)")).toBe("(주)");
  });
});
