const DAY = 86_400_000;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

/** 오늘 날짜 (Asia/Seoul) "YYYY-MM-DD" */
export function today(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date());
}

/** 하루 단위로 옮긴 날짜 ("2026-10-01", -7 → "2026-09-24") */
export function shiftDays(date: string, n: number): string {
  return iso(parse(date) + n * DAY);
}

/** "YYYY-MM" 달력에 보일 날짜들: 1일이 있는 주 일요일 ~ 말일이 있는 주 토요일 */
export function monthGrid(month: string): string[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = Date.UTC(y, m - 1, 1);
  const last = Date.UTC(y, m, 0);
  const start = first - new Date(first).getUTCDay() * DAY;
  const end = last + (6 - new Date(last).getUTCDay()) * DAY;
  const days: string[] = [];
  for (let t = start; t <= end; t += DAY) days.push(iso(t));
  return days;
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return iso(Date.UTC(y, m - 1 + n, 1)).slice(0, 7);
}

export function weekday(date: string): number {
  return new Date(parse(date)).getUTCDay();
}

export const WEEKDAY_LABELS = WEEKDAYS;

/** "2026-03-16" → "3월 16일 (월)" */
export function formatDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}월 ${d}일 (${WEEKDAYS[weekday(date)]})`;
}

/** "2026-03" → "2026년 3월" */
export function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}년 ${m}월`;
}
