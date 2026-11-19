import { describe, expect, it } from "vitest";
import { objectParticle } from "./EventForm.tsx";

/** 삭제 되묻기에서 제목 뒤에 붙는 조사 — "몽이 첫 목욕을" / "몽이 산책를" 이 되면 안 된다 */
describe("objectParticle", () => {
  it("받침이 있으면 을", () => {
    expect(objectParticle("몽이 첫 목욕")).toBe("을");
    expect(objectParticle("몽이 생일")).toBe("을");
  });

  it("받침이 없으면 를", () => {
    expect(objectParticle("몽이 산책하기")).toBe("를");
    expect(objectParticle("회의")).toBe("를");
  });

  it("뒤 공백은 보지 않는다", () => {
    expect(objectParticle("치과  ")).toBe("를");
  });

  it("한글이 아니면 을", () => {
    expect(objectParticle("standup")).toBe("을");
    expect(objectParticle("1:1")).toBe("을");
  });
});
