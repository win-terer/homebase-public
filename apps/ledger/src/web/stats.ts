import { spendOf, splitSmallIncome, type Transaction } from "./api.ts";

/** 통계 집계 (순수 함수). 지출은 원 단위 양수, 취소·환불은 지출에서 상쇄된다. */

export type PeriodKind = "week" | "month" | "year";

export interface Period {
  kind: PeriodKind;
  /** 기간을 가리키는 값: 주간은 그 주의 아무 날짜, 월간은 YYYY-MM, 연간은 YYYY */
  at: string;
  from: string;
  to: string;
  label: string;
  prevAt: string;
  nextAt: string;
}

const DAY = 86_400_000;
const WEEKDAYS_MON = ["월", "화", "수", "목", "금", "토", "일"];

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const md = (date: string) => `${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일`;

/** 월요일 = 0 … 일요일 = 6 */
export const weekdayMon = (date: string) => (new Date(parse(date)).getUTCDay() + 6) % 7;

export function makePeriod(kind: PeriodKind, at: string): Period {
  if (kind === "week") {
    const start = parse(at) - weekdayMon(at) * DAY;
    const from = iso(start);
    const to = iso(start + 6 * DAY);
    return { kind, at: from, from, to, label: `${from.slice(0, 4)}년 ${md(from)} ~ ${md(to)}`, prevAt: iso(start - 7 * DAY), nextAt: iso(start + 7 * DAY) };
  }
  if (kind === "month") {
    const [y, m] = at.split("-").map(Number) as [number, number];
    const from = iso(Date.UTC(y, m - 1, 1));
    const to = iso(Date.UTC(y, m, 0));
    return {
      kind,
      at: from.slice(0, 7),
      from,
      to,
      label: `${y}년 ${m}월`,
      prevAt: iso(Date.UTC(y, m - 2, 1)).slice(0, 7),
      nextAt: iso(Date.UTC(y, m, 1)).slice(0, 7),
    };
  }
  const y = Number(at.slice(0, 4));
  return { kind, at: String(y), from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}년`, prevAt: String(y - 1), nextAt: String(y + 1) };
}

/** at 이 가리키는 기간까지 최근 n 개 기간 (오래된 것부터) */
export function recentPeriods(kind: PeriodKind, at: string, n: number): Period[] {
  const list = [makePeriod(kind, at)];
  while (list.length < n) list.unshift(makePeriod(kind, list[0]!.prevAt));
  return list;
}

/** 기간 비교 막대용 짧은 이름 */
export function shortLabel(p: Period): string {
  if (p.kind === "year") return `${p.at}년`;
  if (p.kind === "month") return `${Number(p.at.slice(5))}월`;
  return `${Number(p.from.slice(5, 7))}/${Number(p.from.slice(8))}`;
}

/** 기간별 지출 합계 */
export function spendByPeriod(txs: Transaction[], periods: Period[]): number[] {
  return periods.map((p) => spendOf(txs.filter((t) => t.date >= p.from && t.date <= p.to)));
}

/** 오늘이 들어 있는 기간의 at 값 */
export function currentAt(kind: PeriodKind, today: string): string {
  return kind === "week" ? today : kind === "month" ? today.slice(0, 7) : today.slice(0, 4);
}

/**
 * 비교할 이전 기간의 기록이 충분한지. 기록이 기간 앞부분(10%)부터 있어야 비교한다.
 * (예: 기록이 10월부터 있으면 작년 전체와의 비교는 의미가 없다)
 */
export function hasFullCoverage(txs: Transaction[], period: Period): boolean {
  if (!txs.length) return false;
  const first = txs.reduce((min, t) => (t.date < min ? t.date : min), txs[0]!.date);
  const length = parse(period.to) - parse(period.from) + DAY;
  return parse(first) - parse(period.from) <= length * 0.1;
}

export interface Summary {
  spend: number;
  income: number;
  net: number;
  /** 지출 건수 (환불 제외) */
  count: number;
  /** 지난 날짜 기준 하루 평균 지출. 아직 시작 안 한 기간이면 0 */
  dailyAvg: number;
  smallIncome: { count: number; total: number };
}

export function summarize(txs: Transaction[], period: Period, today: string): Summary {
  const spend = spendOf(txs);
  const income = txs.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0);
  const { small, smallTotal } = splitSmallIncome(txs);
  const end = today < period.to ? today : period.to;
  const days = end < period.from ? 0 : Math.round((parse(end) - parse(period.from)) / DAY) + 1;
  return {
    spend,
    income,
    net: income - spend,
    count: txs.filter((t) => t.kind === "expense" && t.amount < 0).length,
    dailyAvg: days ? Math.round(spend / days) : 0,
    smallIncome: { count: small.length, total: smallTotal },
  };
}

export interface Bucket {
  key: string;
  /** x축 이름 */
  label: string;
  /** 툴팁 제목 */
  title: string;
  spend: number;
  income: number;
}

/** 주간·월간은 일별, 연간은 월별 */
export function trend(txs: Transaction[], period: Period): Bucket[] {
  const buckets: Bucket[] = [];
  if (period.kind === "year") {
    for (let m = 1; m <= 12; m++) {
      const key = `${period.at}-${String(m).padStart(2, "0")}`;
      buckets.push({ key, label: `${m}월`, title: `${period.at}년 ${m}월`, spend: 0, income: 0 });
    }
  } else {
    for (let t = parse(period.from); t <= parse(period.to); t += DAY) {
      const key = iso(t);
      const wd = WEEKDAYS_MON[weekdayMon(key)]!;
      buckets.push({
        key,
        label: period.kind === "week" ? `${wd} ${Number(key.slice(8))}` : String(Number(key.slice(8))),
        title: `${md(key)} (${wd})`,
        spend: 0,
        income: 0,
      });
    }
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const t of txs) {
    const b = byKey.get(period.kind === "year" ? t.date.slice(0, 7) : t.date);
    if (!b) continue;
    if (t.kind === "expense") b.spend -= t.amount;
    else if (t.kind === "income") b.income += t.amount;
  }
  return buckets;
}

export interface Share {
  label: string;
  value: number;
  /** 전체 대비 비율 0~1 */
  share: number;
  count: number;
}

/** 상위 카테고리별 지출. 7개를 넘으면 나머지는 '기타'로 묶는다 */
export function byCategory(txs: Transaction[], limit = 7): Share[] {
  const map = new Map<string, { value: number; count: number }>();
  for (const t of txs) {
    if (t.kind !== "expense") continue;
    const key = t.categoryGroup ?? "미분류";
    const g = map.get(key) ?? { value: 0, count: 0 };
    g.value -= t.amount;
    if (t.amount < 0) g.count++;
    map.set(key, g);
  }
  const rows = [...map].map(([label, g]) => ({ label, ...g })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const head = rows.slice(0, limit);
  const tail = rows.slice(limit);
  if (tail.length) head.push({ label: "기타", value: tail.reduce((s, r) => s + r.value, 0), count: tail.reduce((s, r) => s + r.count, 0) });
  const total = head.reduce((s, r) => s + r.value, 0);
  return head.map((r) => ({ ...r, share: total ? r.value / total : 0 }));
}

/**
 * 태그별 지출. 분류와 달리 **한 거래가 여러 태그에 들어갈 수 있어** 합이 전체와 안 맞는다
 * (그래서 비중이 아니라 '가장 큰 태그 대비' 막대로 보여 준다).
 *
 * **취소된 짝이 빠진 목록**(`countedRows`)을 받아야 한다. 환불 줄에는 메모가 없어 태그도 안
 * 붙으므로, 다른 통계와 달리 음수로 상쇄되지 않는다 — 취소한 결제가 그대로 남는다
 * (2026-11-12 사용자 지적).
 */
export function byTag(txs: Transaction[], limit = 10): Share[] {
  const map = new Map<string, { value: number; count: number }>();
  for (const t of txs) {
    if (t.kind !== "expense" || !t.tags?.length) continue;
    for (const tag of t.tags) {
      const g = map.get(tag) ?? { value: 0, count: 0 };
      g.value -= t.amount;
      if (t.amount < 0) g.count++;
      map.set(tag, g);
    }
  }
  const rows = [...map]
    .map(([label, g]) => ({ label, ...g }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.value - a.value || b.count - a.count)
    .slice(0, limit);
  const max = rows[0]?.value ?? 0;
  return rows.map((r) => ({ ...r, share: max ? r.value / max : 0 }));
}

/** 가맹점별 결제 횟수와 금액 (환불은 금액에서 빼고 횟수에는 넣지 않는다) */
function merchantTotals(txs: Transaction[]) {
  const map = new Map<string, { value: number; count: number }>();
  for (const t of txs) {
    if (t.kind !== "expense") continue;
    const g = map.get(t.merchant) ?? { value: 0, count: 0 };
    g.value -= t.amount;
    if (t.amount < 0) g.count++;
    map.set(t.merchant, g);
  }
  return [...map].map(([label, g]) => ({ label, ...g })).filter((r) => r.count > 0);
}

/** 많이 쓴 곳: 금액 순 (같으면 횟수 순) */
export function topMerchantsByAmount(txs: Transaction[], limit = 10): Share[] {
  const rows = merchantTotals(txs)
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || b.count - a.count)
    .slice(0, limit);
  const max = rows[0]?.value ?? 0;
  return rows.map((r) => ({ ...r, share: max ? r.value / max : 0 }));
}

/** 자주 간 곳: 결제 횟수 순 (같으면 금액 순) */
export function topMerchants(txs: Transaction[], limit = 10): Share[] {
  const rows = merchantTotals(txs).sort((a, b) => b.count - a.count || b.value - a.value).slice(0, limit);
  const max = rows[0]?.count ?? 0;
  return rows.map((r) => ({ ...r, share: max ? r.count / max : 0 }));
}

export const TIME_SLOTS = ["0~3시", "3~6시", "6~9시", "9~12시", "12~15시", "15~18시", "18~21시", "21~24시"];
export const WEEKDAY_LABELS_MON = WEEKDAYS_MON;

/**
 * 생활 패턴에서 빼는 고정비 (자동결제라 시각이 내 행동과 상관없음. 새벽 0~3시 구독 결제 등).
 * 지출 통계·도넛에는 그대로 들어간다
 */
export const FIXED_COST_GROUPS: ReadonlySet<string> = new Set(["주거", "보험", "통신/구독", "세금/수수료"]);

/** 요일·시간대 패턴에 넣는 결제: 시각이 있는 지출(환불 제외), 고정비 제외 */
const inPattern = (t: Transaction): t is Transaction & { time: string } =>
  t.kind === "expense" && t.amount < 0 && !!t.time && !(t.categoryGroup && FIXED_COST_GROUPS.has(t.categoryGroup));

/**
 * 요일(월~일) × 3시간 단위 결제 횟수와 금액. 시각이 없는 거래와 고정비는 뺀다.
 * 색은 횟수로 정하므로 한 번에 비싸게 쓴 결제도 1회로만 센다
 */
export function weekdayTimeGrid(txs: Transaction[]): { count: number; spend: number }[][] {
  const grid = WEEKDAYS_MON.map(() => TIME_SLOTS.map(() => ({ count: 0, spend: 0 })));
  for (const t of txs) {
    if (!inPattern(t)) continue;
    const cell = grid[weekdayMon(t.date)]![Math.floor(Number(t.time.slice(0, 2)) / 3)]!;
    cell.count++;
    cell.spend -= t.amount;
  }
  return grid;
}

/* ── 통계 상세 (눌러서 보는 거래 목록) ─────────────────────────── */

/** 지출 거래 중 그 카테고리(대분류) 것. 카테고리 없는 건 '미분류' */
export function expensesInGroup(txs: Transaction[], group: string): Transaction[] {
  return txs.filter((t) => t.kind === "expense" && (t.categoryGroup ?? "미분류") === group);
}

/** 도넛의 '기타': 위에 따로 보인 카테고리를 뺀 나머지 지출 */
export function expensesOutside(txs: Transaction[], shown: string[]): Transaction[] {
  const skip = new Set(shown);
  return txs.filter((t) => t.kind === "expense" && !skip.has(t.categoryGroup ?? "미분류"));
}

/** 그 가게의 지출 (묶은 이름 기준) */
export function expensesAt(txs: Transaction[], merchant: string): Transaction[] {
  return txs.filter((t) => t.kind === "expense" && t.merchant === merchant);
}

/** 일별·월별 막대 한 칸: 그날(그 달)의 지출과 수입 (이체 제외) */
export function txsInBucket(txs: Transaction[], period: Period, key: string): Transaction[] {
  return txs.filter((t) => t.kind !== "transfer" && (period.kind === "year" ? t.date.slice(0, 7) : t.date) === key);
}

/** 요일·시간대 칸 하나에 들어간 결제 (weekdayTimeGrid 와 같은 기준) */
export function txsInCell(txs: Transaction[], weekday: number, slot: number): Transaction[] {
  return txs.filter((t) => inPattern(t) && weekdayMon(t.date) === weekday && Math.floor(Number(t.time.slice(0, 2)) / 3) === slot);
}

/** 묶음별 지출 (상세 패널의 막대). 금액 큰 순 */
export function groupSpend(txs: Transaction[], key: (t: Transaction) => string): Share[] {
  const map = new Map<string, { value: number; count: number }>();
  for (const t of txs) {
    if (t.kind !== "expense") continue;
    const k = key(t);
    const g = map.get(k) ?? { value: 0, count: 0 };
    g.value -= t.amount;
    if (t.amount < 0) g.count++;
    map.set(k, g);
  }
  const rows = [...map].map(([label, g]) => ({ label, ...g })).sort((a, b) => b.value - a.value || b.count - a.count);
  const max = Math.max(0, ...rows.map((r) => r.value));
  return rows.map((r) => ({ ...r, share: max > 0 ? Math.max(0, r.value) / max : 0 }));
}

/** 상세 목록 정렬: 최근순(같은 날은 늦은 시각 먼저) 또는 금액 큰 순 */
export function sortTxs(txs: Transaction[], by: "recent" | "amount"): Transaction[] {
  const recent = (a: Transaction, b: Transaction) =>
    b.date.localeCompare(a.date) || (b.time ?? "").localeCompare(a.time ?? "") || b.id - a.id;
  return [...txs].sort(by === "amount" ? (a, b) => Math.abs(b.amount) - Math.abs(a.amount) || recent(a, b) : recent);
}
