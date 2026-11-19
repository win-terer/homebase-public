/** 정기 결제 (서버 /recurring 결과)와 달력 예정 표시 계산 */
import { toBusinessDay } from "../importers/business-days.ts";

export type RecurringPeriod = "week" | "month" | "bimonth" | "year";

export interface RecurringItem {
  key: string;
  name: string;
  kind: "expense" | "transfer" | "income";
  /** 나가는 돈 / 들어오는 돈 */
  direction: "out" | "in";
  review: boolean;
  period: RecurringPeriod;
  anchor: string;
  count: number;
  lastDate: string;
  lastAmount: number;
  changedFrom: number | null;
  nextDate: string;
  missed: boolean;
  category: string | null;
  monthly: number;
  history: { id: number; date: string; amount: number; name?: string }[];
  manual: boolean;
  /** 결제 내역 없이 직접 등록한 것 (연 1회처럼 자동으로는 안 잡히는 것) */
  plan: boolean;
  /** 금액이 매번 다름 (관리비·공과금) */
  variable: boolean;
  /** 내는 날이 들쭉날쭉한 공과금 (다음 예상일 = 마지막 날 + 보통 간격) */
  irregular?: boolean;
  /** 보통 간격(일) */
  gap?: number;
  /** 예정일이 쉬는 날이면 앞 평일(들어오는 돈) / 뒤 평일(나가는 돈)로. null 이면 그대로 */
  shift?: "before" | "after" | null;
  /** 다음에 나갈 금액 (변동이면 최근 3번 평균) */
  expected: number;
  range: [number, number];
  memo: string | null;
  /** 합친 다른 이름들 */
  aliases: string[];
}

export interface RecurringResult {
  today: string;
  items: RecurringItem[];
  ignored: { key: string; name: string }[];
  /** 합치기에서 고를 수 있는 이름들 */
  names: string[];
}

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];

export function periodLabel(r: Pick<RecurringItem, "period" | "anchor" | "irregular" | "gap">): string {
  if (r.irregular) return `보통 ${r.gap}일마다 · 날짜 불규칙`;
  if (r.period === "week") return `매주 ${WEEKDAYS[Number(r.anchor)]}요일`;
  if (r.period === "year") return `매년 ${Number(r.anchor.slice(0, 2))}월 ${Number(r.anchor.slice(3))}일`;
  const day = r.anchor === "31" ? "말일" : `${r.anchor}일`;
  return r.period === "bimonth" ? `2달마다 ${day} 전후` : `매달 ${day} 전후`;
}

const t = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(t(d) + n * 86_400_000);
const lastDay = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** 예정일을 은행 영업일에 맞춤 (급여는 주말이면 앞당겨, 자동이체는 주말 지나서) */
export function dueDate(r: Pick<RecurringItem, "shift">, date: string): string {
  return r.shift ? toBusinessDay(date, r.shift) : date;
}

/** 다음 예상일부터 to 까지 예상일들 (오늘 이후만, 영업일로 옮긴 날짜) */
export function plannedDates(r: RecurringItem, today: string, to: string): string[] {
  const out: string[] = [];
  let d = r.nextDate;
  // 앞당기면 to 안으로 들어올 수 있어서 며칠 더 본다
  for (let i = 0; i < 60 && d <= addDays(to, 5); i++) {
    const due = dueDate(r, d);
    if (due >= today && due <= to) out.push(due);
    const prev = d;
    if (r.irregular) d = iso(t(d) + (r.gap ?? 30) * 86_400_000);
    else if (r.period === "week") d = iso(t(d) + 7 * 86_400_000);
    else if (r.period === "year") d = `${+d.slice(0, 4) + 1}${d.slice(4)}`;
    else {
      const step = r.period === "bimonth" ? 2 : 1;
      const y = +d.slice(0, 4);
      const m0 = +d.slice(5, 7) - 1 + step;
      const ny = y + Math.floor(m0 / 12);
      const nm0 = m0 % 12;
      const day = Number(r.anchor) || +d.slice(8, 10);
      d = iso(Date.UTC(ny, nm0, Math.max(1, Math.min(day, lastDay(ny, nm0)))));
    }
    // 날짜가 앞으로 가지 않으면 (잘못된 결제일 등) 같은 날에 수십 번 그리지 않게 멈춘다
    if (d <= prev) break;
  }
  return out;
}

export interface Planned {
  key: string;
  name: string;
  amount: number;
  date: string;
  variable: boolean;
  memo: string | null;
  direction: "out" | "in";
}

/** 달력 칸마다 예정 결제 (오늘부터, 보이는 기간 안) */
export function plannedByDate(items: RecurringItem[], today: string, from: string, to: string): Map<string, Planned[]> {
  const map = new Map<string, Planned[]>();
  for (const r of items) {
    for (const date of plannedDates(r, today, to)) {
      if (date < from) continue;
      map.set(date, [...(map.get(date) ?? []), { key: r.key, name: r.name, amount: r.expected, date, variable: r.variable, memo: r.memo, direction: r.direction }]);
    }
  }
  return map;
}

export interface MonthEntry {
  item: RecurringItem;
  date: string;
  amount: number;
  /** 이미 나감 / 예정 / 예상일이 지났는데 안 나감 */
  state: "paid" | "planned" | "missed";
}

/** 그 달의 정기 결제: 이미 나간 것(기록)과 앞으로 나갈 것(예상), 안 나간 것 */
export function monthEntries(items: RecurringItem[], month: string, today: string): MonthEntry[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const out: MonthEntry[] = [];
  for (const item of items) {
    for (const h of item.history) if (h.date.startsWith(month)) out.push({ item, date: h.date, amount: h.amount, state: "paid" });
    const due = dueDate(item, item.nextDate);
    if (item.missed && due.startsWith(month)) out.push({ item, date: due, amount: item.expected, state: "missed" });
    for (const d of plannedDates(item, today, end)) if (d.startsWith(month)) out.push({ item, date: d, amount: item.expected, state: "planned" });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
}
