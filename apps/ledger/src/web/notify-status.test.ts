import { describe, expect, it } from "vitest";
import { ago, notifyVerdict, seoulStamp, syncVerdict } from "./notify-status.ts";

const NOW = Date.parse("2026-10-03T03:00:00Z"); // 서울 12:00
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("상대 시각", () => {
  it("분·시간·일로 줄인다", () => {
    expect(ago(at(10_000), NOW)).toBe("방금");
    expect(ago(at(5 * MIN), NOW)).toBe("5분 전");
    expect(ago(at(3 * HOUR), NOW)).toBe("3시간 전");
    expect(ago(at(50 * HOUR), NOW)).toBe("2일 전");
    expect(ago(at(-MIN), NOW)).toBe("방금"); // 시계가 앞선 폰
  });

  it("서울 시각으로 찍는다", () => {
    expect(seoulStamp("2026-10-03T03:08:00Z")).toBe("10/3 12:08");
    expect(seoulStamp("2026-12-31T16:00:00Z")).toBe("1/1 01:00");
  });
});

describe("폰 알림이 오고 있나", () => {
  it("최근이면 ok, 이틀 넘게 없으면 경고", () => {
    expect(notifyVerdict({ lastAt: at(12 * MIN), lastApp: "현대카드", pending: 3 }, NOW)).toMatchObject({ level: "ok", headline: "12분 전", detail: "현대카드 · 10/3 11:48" });
    expect(notifyVerdict({ lastAt: at(49 * HOUR), lastApp: "현대카드", pending: 0 }, NOW).level).toBe("warn");
    expect(notifyVerdict({ lastAt: null, lastApp: null, pending: 0 }, NOW).level).toBe("quiet");
  });
});

describe("자동 가져오기가 돌고 있나", () => {
  const base = { lastOkAt: at(20 * MIN), lastFailAt: null, failStreak: 0, lastStep: null, lastError: null, lastReportAt: at(5 * MIN) };

  it("보고가 없으면 조용, 최근 성공이면 ok", () => {
    expect(syncVerdict(null, NOW).level).toBe("quiet");
    expect(syncVerdict(base, NOW)).toMatchObject({ level: "ok", headline: "20분 전 성공" });
  });

  it("3시간 넘게 보고가 없으면 멈춘 것 — 실패 횟수보다 먼저 본다", () => {
    const v = syncVerdict({ ...base, failStreak: 5, lastReportAt: at(4 * HOUR) }, NOW);
    expect(v.level).toBe("warn");
    expect(v.headline).toBe("4시간 전 이후 소식 없음");
  });

  it("연속 3번부터 실패로 치고, 그 전엔 성공 쪽을 보여 주되 실패를 적는다", () => {
    expect(syncVerdict({ ...base, failStreak: 3, lastStep: "fetch", lastError: "가짜 오류" }, NOW)).toMatchObject({ level: "bad", headline: "3번 연속 실패", detail: "fetch — 가짜 오류" });
    const once = syncVerdict({ ...base, failStreak: 1, lastStep: "upload", lastError: "502" }, NOW);
    expect(once.level).toBe("ok");
    expect(once.detail).toContain("upload — 502");
  });
});
