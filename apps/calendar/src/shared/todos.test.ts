import { describe, expect, it } from "vitest";
import { dueDateFor, dueLabel, isOverdue, monthEnd, weekEnd } from "./todos.ts";

describe("기한 계산", () => {
  it("'이번 주' 는 그 주 토요일 (달력이 일요일 시작이다)", () => {
    expect(weekEnd("2026-11-20")).toBe("2026-11-21"); // 금 → 토
    expect(weekEnd("2026-11-21")).toBe("2026-11-21"); // 토 → 그날
    expect(weekEnd("2026-11-22")).toBe("2026-11-28"); // 일 → 다음 토
  });

  it("'이번 달' 은 말일 (2월·윤년 포함)", () => {
    expect(monthEnd("2026-11-20")).toBe("2026-11-30");
    expect(monthEnd("2026-02-01")).toBe("2026-02-28");
    expect(monthEnd("2028-02-01")).toBe("2028-02-29");
    expect(monthEnd("2026-12-31")).toBe("2026-12-31");
  });

  it("'언젠가' 는 날짜를 안 남기고, '날짜' 는 고른 날 그대로", () => {
    expect(dueDateFor("someday", "2026-11-20", "2026-12-01")).toBeNull();
    expect(dueDateFor("date", "2026-11-20", "2026-12-01")).toBe("2026-12-01");
  });
});

describe("기한 한마디", () => {
  const today = "2026-11-20";
  it("오늘·지남·앞날", () => {
    expect(dueLabel({ dueKind: "date", dueDate: today }, today)).toBe("오늘");
    expect(dueLabel({ dueKind: "date", dueDate: "2026-11-19" }, today)).toBe("어제까지");
    expect(dueLabel({ dueKind: "date", dueDate: "2026-11-17" }, today)).toBe("3일 지남");
    expect(dueLabel({ dueKind: "date", dueDate: "2026-11-25" }, today)).toBe("11월 25일");
  });

  it("러프한 것은 러프하게 보여 준다", () => {
    expect(dueLabel({ dueKind: "someday", dueDate: null }, today)).toBe("언젠가");
    expect(dueLabel({ dueKind: "week", dueDate: "2026-11-21" }, today)).toBe("이번 주");
    expect(dueLabel({ dueKind: "month", dueDate: "2026-11-30" }, today)).toBe("이번 달");
  });

  it("'이번 주' 라고 적어 둔 것도 그 주가 지나면 지난 것이 된다", () => {
    expect(dueLabel({ dueKind: "week", dueDate: "2026-11-14" }, today)).toBe("6일 지남");
  });

  it("'언젠가' 는 영영 안 지난다 — 그게 '언젠가' 의 뜻이다", () => {
    expect(isOverdue({ dueDate: null, doneAt: null }, today)).toBe(false);
    expect(isOverdue({ dueDate: "2026-11-01", doneAt: null }, today)).toBe(true);
    expect(isOverdue({ dueDate: "2026-11-01", doneAt: "2026-11-02T00:00:00Z" }, today)).toBe(false);
  });
});
