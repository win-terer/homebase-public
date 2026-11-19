/**
 * 구글 캘린더 내보내기(.ics) 읽기 (브라우저). 원본은 기기를 떠나지 않고, 일정으로 옮길 값만 서버로 보낸다.
 * 2026-10 사용자 파일 기준: 시각은 대부분 UTC(…Z), 일부 TZID=Asia/Seoul, 종일은 VALUE=DATE(끝 날짜는 다음 날).
 * 반복은 MONTHLY;BYMONTHDAY, YEARLY, WEEKLY;INTERVAL=n;COUNT, 한 회차만 바꾼 건 RECURRENCE-ID, 뺀 날은 EXDATE.
 * 제목이 숫자로 끝나는 건(`가게 0.89`, 만원 단위) 예전에 지출을 적던 기록 → 일정에서 빼고, 상세 메모는 가계부로 보낼 수 있다.
 */
import { addDays, daysBetween, MAX_SPAN_DAYS, type Repeat } from "../shared/occurrences.ts";

export interface IcsEvent {
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  repeat: Repeat | null;
  repeatUntil: string | null;
  skipDates: string[];
}

/** 예전 지출 기록 (제목 끝 금액) */
export interface MoneyRecord {
  date: string;
  /** 원 */
  amount: number;
  /** 제목에서 금액을 뗀 것 */
  title: string;
  description: string | null;
}

export interface IcsCalendar {
  name: string;
  events: IcsEvent[];
  money: MoneyRecord[];
  /** 지출 기록을 일정으로도 넣고 싶을 때 쓸 일정 (money 와 같은 순서) */
  moneyEvents: IcsEvent[];
  /** 옮길 수 없어서 첫 회차만 넣은 반복 */
  unsupported: number;
  /** 63일보다 길어서 뺀 일정 */
  tooLong: number;
}

/** 제목 끝 금액: "치킨 2.3" → 23,000원 (만원 단위) */
const MONEY = /^(.*?)\s+(-?\d+(?:\.\d+)?)\s*$/;

export function moneyOf(title: string): { title: string; amount: number } | null {
  const m = MONEY.exec(title);
  if (!m) return null;
  const amount = Math.round(Math.abs(parseFloat(m[2]!)) * 10_000);
  return amount > 0 ? { title: m[1]!.trim(), amount } : null;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function unescape(v: string): string {
  return v.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function parseLine(line: string): Prop | null {
  // NAME;PARAM=V;PARAM=V:VALUE (값 안의 : 는 그대로)
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(";");
  const p: Record<string, string> = {};
  for (const kv of params) {
    const i = kv.indexOf("=");
    if (i > 0) p[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1).replace(/^"|"$/g, "");
  }
  return { name: name!.toUpperCase(), params: p, value: line.slice(colon + 1) };
}

/** DTSTART 등 → 서울 기준 날짜·시각. 종일이면 time = null */
export function toSeoul(prop: Prop): { date: string; time: string | null } {
  const v = prop.value.trim();
  if (prop.params.VALUE === "DATE" || /^\d{8}$/.test(v)) return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, time: null };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) throw new Error(`날짜 형식을 모르겠어요: ${v}`);
  const [, y, mo, d, h, mi, , z] = m;
  if (z) {
    // UTC → 서울(+9시간, 서머타임 없음)
    const t = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h! + 9, +mi!));
    return { date: t.toISOString().slice(0, 10), time: t.toISOString().slice(11, 16) };
  }
  // TZID=Asia/Seoul 이거나 시간대 없음 → 그대로 (다른 시간대는 사용자 파일에 없음)
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
}

function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

interface RawEvent {
  props: Map<string, Prop[]>;
}

const one = (e: RawEvent, name: string) => e.props.get(name)?.[0];

/** 일정 한 개의 날짜 범위. 종일 일정의 DTEND 는 다음 날이라 하루 뺀다, 자정에 끝나는 일정은 그날 23:59 까지 */
function span(e: RawEvent): Pick<IcsEvent, "startDate" | "endDate" | "startTime" | "endTime"> {
  const start = toSeoul(one(e, "DTSTART")!);
  const endProp = one(e, "DTEND");
  if (!start.time) {
    const end = endProp ? addDays(toSeoul(endProp).date, -1) : start.date;
    return { startDate: start.date, endDate: end < start.date ? start.date : end, startTime: null, endTime: null };
  }
  if (!endProp) return { startDate: start.date, endDate: start.date, startTime: start.time, endTime: null };
  let end = toSeoul(endProp);
  if (end.time === "00:00" && end.date > start.date) end = { date: addDays(end.date, -1), time: "23:59" };
  return { startDate: start.date, endDate: end.date < start.date ? start.date : end.date, startTime: start.time, endTime: end.time ?? null };
}

/** RRULE → homebase 반복. 못 옮기는 규칙은 null + unsupported, 4주마다 같은 건 펼칠 날짜들 */
function repeatOf(rrule: string, startDate: string): { repeat: Repeat | null; until: string | null; expand?: string[]; unsupported?: boolean } {
  const r = Object.fromEntries(rrule.split(";").map((kv) => kv.split("=") as [string, string]));
  const interval = Number(r.INTERVAL ?? 1);
  const count = r.COUNT ? Number(r.COUNT) : null;
  const untilRaw = r.UNTIL ? toSeoul({ name: "UNTIL", params: {}, value: r.UNTIL }).date : null;
  const dom = +startDate.slice(8, 10);
  const weekday = new Date(`${startDate}T00:00:00Z`).getUTCDay();
  const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  let repeat: Repeat | null = null;
  if (r.FREQ === "WEEKLY" && (!r.BYDAY || r.BYDAY === BYDAY[weekday])) repeat = "weekly";
  else if (r.FREQ === "MONTHLY" && (!r.BYMONTHDAY || Number(r.BYMONTHDAY) === dom) && !r.BYDAY) repeat = "monthly";
  else if (r.FREQ === "YEARLY" && !r.BYDAY && !r.BYMONTH) repeat = "yearly";
  if (!repeat) return { repeat: null, until: null, unsupported: true };

  const step = (d: string, n: number): string => {
    if (repeat === "weekly") return addDays(d, 7 * n);
    const y = +d.slice(0, 4);
    const m0 = +d.slice(5, 7) - 1 + (repeat === "monthly" ? n : 12 * n);
    const ny = y + Math.floor(m0 / 12);
    const nm0 = ((m0 % 12) + 12) % 12;
    const last = new Date(Date.UTC(ny, nm0 + 1, 0)).getUTCDate();
    return new Date(Date.UTC(ny, nm0, Math.min(dom, last))).toISOString().slice(0, 10);
  };
  if (interval > 1) {
    // 2주·4주마다 같은 건 homebase 반복에 없어서 날짜마다 따로 넣는다 (최대 2년 치)
    const out: string[] = [];
    for (let i = 0; i < 200; i++) {
      const d = step(startDate, i * interval);
      if ((count !== null && i >= count) || (untilRaw && d > untilRaw) || daysBetween(startDate, d) > 730) break;
      out.push(d);
    }
    return { repeat: null, until: null, expand: out };
  }
  const until = untilRaw ?? (count !== null ? step(startDate, count - 1) : null);
  return { repeat, until };
}

/** .ics 한 개 → 캘린더 (이름·일정·예전 지출 기록) */
export function parseIcs(text: string, fallbackName = "가져온 캘린더"): IcsCalendar {
  const lines = unfold(text);
  let name = fallbackName;
  const raw: RawEvent[] = [];
  let cur: RawEvent | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = { props: new Map() };
    else if (line === "END:VEVENT") {
      if (cur) raw.push(cur);
      cur = null;
    } else {
      const p = parseLine(line);
      if (!p) continue;
      if (cur) cur.props.set(p.name, [...(cur.props.get(p.name) ?? []), p]);
      else if (p.name === "X-WR-CALNAME" && p.value.trim()) name = unescape(p.value.trim());
    }
  }

  const cal: IcsCalendar = { name, events: [], money: [], moneyEvents: [], unsupported: 0, tooLong: 0 };
  const text_ = (e: RawEvent, k: string) => {
    const v = one(e, k)?.value;
    return v ? unescape(v).trim() || null : null;
  };
  const live = raw.filter((e) => one(e, "DTSTART") && (one(e, "STATUS")?.value ?? "").toUpperCase() !== "CANCELLED");
  // 한 회차만 바꾼 것: 원래 일정에서 그날을 빼고 따로 한 번짜리로
  const overrides = new Map<string, string[]>();
  for (const e of live) {
    const rid = one(e, "RECURRENCE-ID");
    if (rid) overrides.set(one(e, "UID")!.value, [...(overrides.get(one(e, "UID")!.value) ?? []), toSeoul(rid).date]);
  }
  for (const e of raw) {
    const rid = one(e, "RECURRENCE-ID");
    if (rid && (one(e, "STATUS")?.value ?? "").toUpperCase() === "CANCELLED") {
      overrides.set(one(e, "UID")!.value, [...(overrides.get(one(e, "UID")!.value) ?? []), toSeoul(rid).date]);
    }
  }

  for (const e of live) {
    const baseUid = one(e, "UID")?.value ?? `${name}-${raw.indexOf(e)}`;
    const rid = one(e, "RECURRENCE-ID");
    const uid = rid ? `${baseUid}#${rid.value}` : baseUid;
    const title = text_(e, "SUMMARY") ?? "(제목 없음)";
    const when = span(e);
    const money = moneyOf(title);
    if (money) {
      cal.money.push({ date: when.startDate, amount: money.amount, title: money.title, description: text_(e, "DESCRIPTION") });
      cal.moneyEvents.push({ uid, title, description: text_(e, "DESCRIPTION"), location: text_(e, "LOCATION"), ...when, repeat: null, repeatUntil: null, skipDates: [] });
      continue;
    }
    if (daysBetween(when.startDate, when.endDate) > MAX_SPAN_DAYS) {
      cal.tooLong++;
      continue;
    }
    const base = { title, description: text_(e, "DESCRIPTION"), location: text_(e, "LOCATION"), ...when };
    const rrule = rid ? undefined : one(e, "RRULE")?.value;
    if (!rrule) {
      cal.events.push({ uid, ...base, repeat: null, repeatUntil: null, skipDates: [] });
      continue;
    }
    const rep = repeatOf(rrule, when.startDate);
    const skip = [...(e.props.get("EXDATE") ?? []).flatMap((p) => p.value.split(",").map((v) => toSeoul({ ...p, value: v }).date)), ...(overrides.get(baseUid) ?? [])];
    if (rep.expand) {
      const len = daysBetween(when.startDate, when.endDate);
      for (const d of rep.expand) {
        if (skip.includes(d)) continue;
        cal.events.push({ uid: `${uid}@${d}`, ...base, startDate: d, endDate: addDays(d, len), repeat: null, repeatUntil: null, skipDates: [] });
      }
      continue;
    }
    if (rep.unsupported) cal.unsupported++;
    cal.events.push({ uid, ...base, repeat: rep.repeat, repeatUntil: rep.until, skipDates: [...new Set(skip)].sort() });
  }
  return cal;
}

/** 시작일 이후만: 한 번짜리는 끝나는 날, 반복은 반복이 끝나는 날 기준 */
export function sinceDate(events: IcsEvent[], from: string): IcsEvent[] {
  return events.filter((e) => (e.repeat ? !e.repeatUntil || e.repeatUntil >= from : e.endDate >= from));
}
