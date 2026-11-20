/**
 * 일정 펼치기 (서버·화면 공용 순수 함수). 저장된 일정(반복 포함)을 [from, to] 날짜별 칸으로 펼친다.
 * 여러 날 일정은 걸친 날마다 한 칸씩, 반복은 매주(시작일 요일) / 매달(시작일 날짜, 없는 달은 말일) / 매년(2/29 는 평년엔 2/28).
 */

export type Repeat = "weekly" | "monthly" | "yearly";

export interface CalendarEvent {
  id: number;
  categoryId: number | null;
  title: string;
  startDate: string;
  /** 마지막 날 (포함) */
  endDate: string;
  /** "HH:MM", 없으면 종일 */
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  memo: string | null;
  repeat: Repeat | null;
  /** 반복 끝 날짜 (포함), 없으면 계속 */
  repeatUntil: string | null;
  /** 반복 중 뺀 날짜들 (그 회차의 시작일) */
  skipDates: string[];
  /** 만든 시각 (ISO). **방금 적은 일정은 바로 고치게** 열어 주는 데 쓴다 (CalendarRoot) */
  createdAt?: string;
}

export interface Occurrence {
  event: CalendarEvent;
  /** 이 칸의 날짜 */
  date: string;
  /** 이 회차의 시작일·마지막 날 */
  start: string;
  end: string;
}

/** 한 번짜리 일정의 최대 길이(일). 서버는 시작일 범위로 찾으므로 이보다 길면 안 된다 */
export const MAX_SPAN_DAYS = 62;

const DAY = 86_400_000;
const t = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => iso(t(d) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((t(b) - t(a)) / DAY);
const lastDay = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** 이 일정의 회차 시작일들 중 [from, to] 칸에 걸칠 수 있는 것 */
function starts(e: CalendarEvent, from: string, to: string): string[] {
  const span = daysBetween(e.startDate, e.endDate);
  const until = e.repeatUntil && e.repeatUntil < to ? e.repeatUntil : to;
  const out: string[] = [];
  if (!e.repeat) return e.startDate <= to && e.endDate >= from ? [e.startDate] : [];
  if (e.repeat === "weekly") {
    // from - span 이후 첫 회차부터
    const lead = addDays(from, -span);
    const k = Math.max(0, Math.ceil(daysBetween(e.startDate, lead) / 7));
    for (let d = addDays(e.startDate, k * 7); d <= until; d = addDays(d, 7)) out.push(d);
  } else if (e.repeat === "yearly") {
    const month0 = +e.startDate.slice(5, 7) - 1;
    const dom = +e.startDate.slice(8, 10);
    const firstYear = Math.max(+e.startDate.slice(0, 4), +addDays(from, -span).slice(0, 4));
    for (let y = firstYear; y <= +until.slice(0, 4); y++) {
      const d = iso(Date.UTC(y, month0, Math.min(dom, lastDay(y, month0))));
      if (d >= e.startDate && d <= until) out.push(d);
    }
  } else {
    const dom = +e.startDate.slice(8, 10);
    let y = +e.startDate.slice(0, 4);
    let m0 = +e.startDate.slice(5, 7) - 1;
    // from 보다 두 달 넘게 앞선 회차는 칸에 걸칠 수 없다 (span ≤ 62)
    const lead = addDays(from, -span);
    const ly = +lead.slice(0, 4);
    const lm0 = +lead.slice(5, 7) - 1;
    if (ly * 12 + lm0 > y * 12 + m0) {
      y = ly;
      m0 = lm0;
    }
    for (let i = 0; i < 600; i++) {
      const d = iso(Date.UTC(y, m0, Math.min(dom, lastDay(y, m0))));
      if (d > until) break;
      if (d >= e.startDate) out.push(d);
      m0 += 1;
      if (m0 === 12) {
        m0 = 0;
        y += 1;
      }
    }
  }
  const skip = new Set(e.skipDates);
  return out.filter((d) => !skip.has(d) && addDays(d, span) >= from);
}

/** [from, to] 날짜별 일정 칸. 하루 안에서는 종일 → 시각 순 */
export function expandEvents(events: CalendarEvent[], from: string, to: string): Map<string, Occurrence[]> {
  const map = new Map<string, Occurrence[]>();
  for (const e of events) {
    const span = daysBetween(e.startDate, e.endDate);
    for (const start of starts(e, from, to)) {
      const end = addDays(start, span);
      for (let d = start < from ? from : start; d <= end && d <= to; d = addDays(d, 1)) {
        map.set(d, [...(map.get(d) ?? []), { event: e, date: d, start, end }]);
      }
    }
  }
  for (const list of map.values()) list.sort(compareOccurrences);
  return map;
}

/** 종일·여러 날 일정이 먼저, 그다음 시작 시각, 제목 */
export function compareOccurrences(a: Occurrence, b: Occurrence): number {
  const at = a.date === a.start ? a.event.startTime : null;
  const bt = b.date === b.start ? b.event.startTime : null;
  if ((at === null) !== (bt === null)) return at === null ? -1 : 1;
  return (at ?? "").localeCompare(bt ?? "") || a.event.title.localeCompare(b.event.title) || a.event.id - b.event.id;
}

/** 일정 시각 표시: "종일" / "14:00" / "14:00–15:30" / 여러 날이면 그날 기준 */
export function timeLabel(o: Occurrence): string {
  const { startTime, endTime } = o.event;
  if (!startTime) return "종일";
  if (o.start !== o.end) {
    if (o.date === o.start) return `${startTime}부터`;
    if (o.date === o.end) return endTime ? `${endTime}까지` : "종일";
    return "종일";
  }
  return endTime && endTime !== startTime ? `${startTime}–${endTime}` : startTime;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function repeatLabel(e: Pick<CalendarEvent, "repeat" | "startDate" | "repeatUntil">): string | null {
  if (!e.repeat) return null;
  const base =
    e.repeat === "weekly"
      ? `매주 ${WEEKDAYS[new Date(t(e.startDate)).getUTCDay()]}요일`
      : e.repeat === "yearly"
        ? `매년 ${+e.startDate.slice(5, 7)}월 ${+e.startDate.slice(8, 10)}일`
        : `매달 ${+e.startDate.slice(8, 10)}일`;
  return e.repeatUntil ? `${base} · ${+e.repeatUntil.slice(5, 7)}월 ${+e.repeatUntil.slice(8, 10)}일까지` : base;
}
