import { describe, expect, it } from "vitest";
import { parseQuickTime } from "./quick-time.ts";

describe("제목에서 시각 읽기", () => {
  const cases: [string, string, string | null, string | null][] = [
    ["09:00 치과", "치과", "09:00", null],
    ["치과 09:00", "치과", "09:00", null],
    ["9:30 팀 회의", "팀 회의", "09:30", null],
    ["9시 치과", "치과", "09:00", null],
    ["9시 30분 치과", "치과", "09:30", null],
    ["9시반 치과", "치과", "09:30", null],
    ["오후 7시 저녁약속", "저녁약속", "19:00", null],
    ["저녁 7:30 약속", "약속", "19:30", null],
    ["오전 12시 당직", "당직", "00:00", null],
    ["오후 12시 점심", "점심", "12:00", null],
    ["밤 12시 마감", "마감", "00:00", null],
    ["새벽 1시 배포", "배포", "01:00", null],
    ["19:00 운동", "운동", "19:00", null],
    ["09:00~10:30 워크숍", "워크숍", "09:00", "10:30"],
    ["9시~11시 정기점검", "정기점검", "09:00", "11:00"],
    ["14:00 - 15:00 면담", "면담", "14:00", "15:00"],
    ["09:00에 출발", "출발", "09:00", null],
    ["3시쯤 커피", "커피", "03:00", null], // 말머리가 없으면 적은 그대로. 오후면 "오후 3시"
  ];
  for (const [input, title, startTime, endTime] of cases) {
    it(input, () => {
      const got = parseQuickTime(input);
      expect(got.title).toBe(title);
      expect(got.startTime).toBe(startTime);
      expect(got.endTime).toBe(endTime);
    });
  }
});

describe("시각이 아닌 것은 건드리지 않는다", () => {
  for (const input of ["치과 예약", "7시간 운동", "3팀 회의", "2024 결산", "100번 버스", "A/S 접수"]) {
    it(input, () => {
      expect(parseQuickTime(input)).toEqual({ title: input, startTime: null, endTime: null });
    });
  }
});

it("앞뒤 공백은 정리한다", () => {
  expect(parseQuickTime("  09:00   치과  ")).toEqual({ title: "치과", startTime: "09:00", endTime: null });
});

it("떨어져 있는 두 시각은 한 덩어리로 묶지 않는다", () => {
  const got = parseQuickTime("9시 회의 ~ 10시 보고");
  expect(got.startTime).toBe("09:00");
  expect(got.endTime).toBe(null);
});
