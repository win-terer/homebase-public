import { describe, expect, it } from "vitest";
import { moneyOf, parseIcs, sinceDate } from "./ics.ts";

const ics = (events: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "X-WR-CALNAME:가짜 캘린더",
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Seoul",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "END:STANDARD",
    "END:VTIMEZONE",
    ...events.flatMap((e) => ["BEGIN:VEVENT", ...e.trim().split("\n").map((l) => l.trim()), "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");

describe("parseIcs", () => {
  it("reads the calendar name, converts UTC to Seoul and all-day end dates", () => {
    const cal = parseIcs(
      ics([
        "UID:a\nSUMMARY:가짜 저녁 약속\nDTSTART:20261002T100000Z\nDTEND:20261002T120000Z\nLOCATION:가짜 식당\\, 2층",
        "UID:b\nSUMMARY:가짜 여행\nDTSTART;VALUE=DATE:20261022\nDTEND;VALUE=DATE:20261026",
        "UID:c\nSUMMARY:가짜 밤샘\nDTSTART;TZID=Asia/Seoul:20261003T220000\nDTEND;TZID=Asia/Seoul:20261004T000000\nDESCRIPTION:첫 줄\\n둘째 줄",
      ]),
    );
    expect(cal.name).toBe("가짜 캘린더");
    expect(cal.events).toMatchObject([
      { uid: "a", startDate: "2026-10-02", startTime: "19:00", endTime: "21:00", location: "가짜 식당, 2층" },
      { uid: "b", startDate: "2026-10-22", endDate: "2026-10-25", startTime: null },
      { uid: "c", startDate: "2026-10-03", endDate: "2026-10-03", startTime: "22:00", endTime: "23:59", description: "첫 줄\n둘째 줄" },
    ]);
  });

  it("separates old spending records (title ending with an amount in 만원)", () => {
    const cal = parseIcs(ics(["UID:m\nSUMMARY:가짜치킨 2.3\nDTSTART:20261001T110000Z\nDTEND:20261001T120000Z\nDESCRIPTION:양념 반 후라이드 반"]));
    expect(cal.events).toEqual([]);
    expect(cal.money).toEqual([{ date: "2026-10-01", amount: 23000, title: "가짜치킨", description: "양념 반 후라이드 반" }]);
    expect(moneyOf("가짜커피 0.45")).toEqual({ title: "가짜커피", amount: 4500 });
    expect(moneyOf("3시 회의")).toBeNull();
  });

  it("maps monthly/yearly/count repeats, exdates and single changed occurrences", () => {
    const cal = parseIcs(
      ics([
        "UID:r1\nSUMMARY:가짜 월례\nDTSTART;VALUE=DATE:20260125\nDTEND;VALUE=DATE:20260126\nRRULE:FREQ=MONTHLY;COUNT=3;BYMONTHDAY=25",
        "UID:r2\nSUMMARY:가짜 생일\nDTSTART;VALUE=DATE:20200309\nDTEND;VALUE=DATE:20200310\nRRULE:FREQ=YEARLY",
        "UID:r3\nSUMMARY:가짜 정기\nDTSTART;TZID=Asia/Seoul:20260115T090000\nDTEND;TZID=Asia/Seoul:20260115T100000\nRRULE:FREQ=MONTHLY;UNTIL=20261231T145959Z;BYMONTHDAY=15\nEXDATE;TZID=Asia/Seoul:20260315T090000",
        "UID:r3\nSUMMARY:가짜 정기 (옮김)\nRECURRENCE-ID;TZID=Asia/Seoul:20260415T090000\nDTSTART;TZID=Asia/Seoul:20260416T090000\nDTEND;TZID=Asia/Seoul:20260416T100000",
      ]),
    );
    expect(cal.events.find((e) => e.uid === "r1")).toMatchObject({ repeat: "monthly", repeatUntil: "2026-03-25" });
    expect(cal.events.find((e) => e.uid === "r2")).toMatchObject({ repeat: "yearly", repeatUntil: null });
    expect(cal.events.find((e) => e.uid === "r3")).toMatchObject({ repeat: "monthly", repeatUntil: "2026-12-31", skipDates: ["2026-03-15", "2026-04-15"] });
    expect(cal.events.find((e) => e.uid.startsWith("r3#"))).toMatchObject({ title: "가짜 정기 (옮김)", startDate: "2026-04-16", repeat: null });
  });

  it("expands every-4-weeks repeats into separate dates", () => {
    const cal = parseIcs(ics(["UID:w\nSUMMARY:가짜 4주\nDTSTART:20260105T000000Z\nDTEND:20260105T010000Z\nRRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=4"]));
    expect(cal.events.map((e) => e.startDate)).toEqual(["2026-01-05", "2026-02-02", "2026-03-02"]);
    expect(cal.events.every((e) => e.repeat === null)).toBe(true);
  });

  it("keeps events (and repeats) that reach the start date", () => {
    const cal = parseIcs(
      ics([
        "UID:old\nSUMMARY:가짜 옛날\nDTSTART;VALUE=DATE:20230101\nDTEND;VALUE=DATE:20230102",
        "UID:new\nSUMMARY:가짜 요즘\nDTSTART;VALUE=DATE:20241001\nDTEND;VALUE=DATE:20241002",
        "UID:rep\nSUMMARY:가짜 계속\nDTSTART;VALUE=DATE:20200101\nDTEND;VALUE=DATE:20200102\nRRULE:FREQ=YEARLY",
      ]),
    );
    expect(sinceDate(cal.events, "2024-09-01").map((e) => e.uid)).toEqual(["new", "rep"]);
  });
});
