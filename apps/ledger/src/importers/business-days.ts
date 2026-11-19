/** 쉬는 날(주말·공휴일). 공휴일은 @hyunbinseo/holidays-kr (월력요항 기반, 매년 패키지 업데이트) */
import * as holidays from "@hyunbinseo/holidays-kr/all";

export const HOLIDAYS: Record<string, readonly string[]> = Object.assign({}, ...Object.values(holidays));

export function isOffDay(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6 || Boolean(HOLIDAYS[date]);
}

/** 쉬는 날이면 앞(before) 또는 뒤(after)의 가장 가까운 평일로 */
export function toBusinessDay(date: string, shift: "before" | "after"): string {
  let ms = Date.parse(`${date}T00:00:00Z`);
  for (let i = 0; i < 14; i++) {
    const d = new Date(ms).toISOString().slice(0, 10);
    if (!isOffDay(d)) return d;
    ms += (shift === "before" ? -1 : 1) * 86_400_000;
  }
  return date;
}
