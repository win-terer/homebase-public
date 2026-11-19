import { describe, expect, it } from "vitest";
import { expandEvents, repeatLabel, timeLabel, type CalendarEvent } from "./occurrences.ts";

let id = 0;
const ev = (p: Partial<CalendarEvent>): CalendarEvent => ({
  id: ++id,
  categoryId: null,
  title: "가짜 일정",
  startDate: "2026-10-05",
  endDate: p.startDate ?? "2026-10-05",
  startTime: null,
  endTime: null,
  location: null,
  memo: null,
  repeat: null,
  repeatUntil: null,
  skipDates: [],
  ...p,
});
const dates = (m: Map<string, unknown[]>) => [...m.keys()].sort();

describe("expandEvents", () => {
  it("puts a multi-day event on every day it covers, clipped to the range", () => {
    const m = expandEvents([ev({ startDate: "2026-09-29", endDate: "2026-10-02" })], "2026-10-01", "2026-10-31");
    expect(dates(m)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(m.get("2026-10-01")![0]).toMatchObject({ start: "2026-09-29", end: "2026-10-02" });
  });

  it("repeats weekly on the start weekday and skips removed dates", () => {
    const e = ev({ startDate: "2026-09-07", repeat: "weekly", skipDates: ["2026-10-12"] }); // 월요일
    expect(dates(expandEvents([e], "2026-10-01", "2026-10-31"))).toEqual(["2026-10-05", "2026-10-19", "2026-10-26"]);
  });

  it("repeats monthly on the start day, using the month end when the day is missing", () => {
    const e = ev({ startDate: "2026-01-31", repeat: "monthly", repeatUntil: "2026-04-30" });
    expect(dates(expandEvents([e], "2026-01-01", "2026-12-31"))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    // 시작 전 달에는 없다
    expect(dates(expandEvents([ev({ startDate: "2026-10-25", repeat: "monthly" })], "2026-09-01", "2026-11-30"))).toEqual(["2026-10-25", "2026-11-25"]);
  });

  it("finds far-away repeats without walking from the start (and a repeat that spills into the range)", () => {
    const weekly = ev({ startDate: "2020-01-06", repeat: "weekly" });
    expect(dates(expandEvents([weekly], "2026-10-01", "2026-10-07"))).toEqual(["2026-10-05"]);
    const trip = ev({ startDate: "2026-08-30", endDate: "2026-09-02", repeat: "monthly" });
    // 9/30 회차가 10/3 까지 이어진다
    expect(dates(expandEvents([trip], "2026-10-01", "2026-10-05"))).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("repeats yearly (birthdays), Feb 29 falls back to Feb 28", () => {
    expect(dates(expandEvents([ev({ startDate: "2020-10-09", repeat: "yearly" })], "2026-10-01", "2026-10-31"))).toEqual(["2026-10-09"]);
    expect(dates(expandEvents([ev({ startDate: "2024-02-29", repeat: "yearly" })], "2026-02-01", "2026-03-31"))).toEqual(["2026-02-28"]);
    expect(repeatLabel({ repeat: "yearly", startDate: "2020-10-09", repeatUntil: null })).toBe("매년 10월 9일");
  });

  it("orders all-day first, then by start time", () => {
    const m = expandEvents(
      [ev({ title: "저녁", startTime: "19:00" }), ev({ title: "종일" }), ev({ title: "점심", startTime: "12:00" })],
      "2026-10-05",
      "2026-10-05",
    );
    expect(m.get("2026-10-05")!.map((o) => o.event.title)).toEqual(["종일", "점심", "저녁"]);
  });
});

describe("labels", () => {
  it("formats times and repeats", () => {
    const one = expandEvents([ev({ startTime: "14:00", endTime: "15:30" })], "2026-10-05", "2026-10-05").get("2026-10-05")![0]!;
    expect(timeLabel(one)).toBe("14:00–15:30");
    expect(repeatLabel({ repeat: "weekly", startDate: "2026-10-05", repeatUntil: null })).toBe("매주 월요일");
    expect(repeatLabel({ repeat: "monthly", startDate: "2026-10-25", repeatUntil: "2026-12-25" })).toBe("매달 25일 · 12월 25일까지");
  });
});
