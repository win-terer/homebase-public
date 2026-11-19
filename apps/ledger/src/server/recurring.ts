import { isOffDay } from "../importers/business-days.ts";

/**
 * 정기 결제 찾기 (순수 함수). 같은 이름(뒤 숫자를 뗀 값)으로 거의 같은 간격마다 나간 돈을 묶는다.
 * 휴일·주말 때문에 며칠 밀리는 건 허용한다. 공과금은 날짜가 들쭉날쭉해도 본다(irregular).
 */

export type Period = "week" | "month" | "bimonth" | "year";

export interface RecurringInput {
  id: number;
  key: string;
  /** 화면용 이름 */
  name: string;
  kind: "expense" | "transfer" | "income";
  /** 확인 필요로 남아 있는 이체 */
  review: boolean;
  date: string;
  /** 금액 (양수). 들어온 돈이면 direction 이 in */
  amount: number;
  direction?: "out" | "in";
  category: string | null;
  /** 대분류 이름 (금액이 바뀌는 고정비 판단용) */
  group?: string | null;
  /** '이름이 바뀐 같은 결제 합치기'로 들어온 기록 (제목은 원래 이름으로) */
  merged?: boolean;
}

export interface Recurring {
  key: string;
  name: string;
  kind: "expense" | "transfer" | "income";
  /** 나가는 돈 / 들어오는 돈 (급여 등) */
  direction: "out" | "in";
  review: boolean;
  period: Period;
  /** 매달이면 결제일(1~31, 말일 근처는 31), 매주면 요일(0=월), 매년이면 MM-DD */
  anchor: string;
  count: number;
  lastDate: string;
  lastAmount: number;
  /** 직전 금액과 다르면 직전 금액 */
  changedFrom: number | null;
  nextDate: string;
  /** 예상일이 일주일 넘게 지났는데 안 나감 (해지했을 수도) */
  missed: boolean;
  category: string | null;
  /** 한 달로 환산한 금액 */
  monthly: number;
  history: { id: number; date: string; amount: number; name: string }[];
  /** 사용자가 직접 정기로 표시한 것 */
  manual: boolean;
  /** 결제 내역 없이 **직접 등록**한 것 (연 1회처럼 자동으로는 안 잡히는 것) */
  plan: boolean;
  /** 금액이 매번 다름 (관리비·공과금 등) */
  variable: boolean;
  /** 내는 날이 들쭉날쭉한 공과금: 다음 예상일 = 마지막 날 + 보통 간격 */
  irregular: boolean;
  /** 보통 간격(일, 중앙값) */
  gap: number;
  /**
   * 예정일이 주말·공휴일이면: 들어오는 돈은 앞 평일(before), 나가는 돈은 뒤 평일(after).
   * 지난 기록에 쉬는 날 결제가 한 번도 없을 때만 (카드 결제처럼 주말에도 나가는 건 null)
   */
  shift: "before" | "after" | null;
  /** 다음에 나갈 것으로 보는 금액 (변동이면 최근 3번 평균) */
  expected: number;
  /** 최근 3번 금액 범위 */
  range: [number, number];
  /** 정기 결제 메모 (설정에 저장) */
  memo: string | null;
}

/** 금액이 매번 달라도 정기로 볼 고정비 (카테고리 대분류 또는 이름) */
const VARIABLE_GROUPS = new Set(["주거", "통신/구독", "보험", "세금/수수료", "급여"]);
// 이체로 나가는 건 카테고리가 없어서 이름으로도 본다 (대출 이자는 원금 상환에 따라, 공과금은 계절에 따라 바뀜)
const VARIABLE_NAMES = /관리|가스|전기|한전|한국전력|수도|통신|KT|SKT|LG ?U\+|유플러스|대출|주택금융|이자|보험|생명|화재|손해|급여|월급/i;

const DAY = 86_400_000;
const t = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const lastDayOf = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** 한 달로 환산할 때 곱하는 수 (직접 등록한 것도 같은 기준으로 센다 — recurring-plan.ts) */
export const PER_MONTH: Record<Period, number> = { week: 52 / 12, month: 1, bimonth: 1 / 2, year: 1 / 12 };

/** 주기마다 허용하는 간격(일)과 '대부분'의 범위 */
const RULES: Record<Period, { median: [number, number]; each: [number, number]; grace: number; perMonth: number }> = {
  week: { median: [6, 8], each: [4, 10], grace: 3, perMonth: PER_MONTH.week },
  month: { median: [26, 35], each: [22, 40], grace: 7, perMonth: PER_MONTH.month },
  // 2달에 한 번 (수도세 등)
  bimonth: { median: [55, 66], each: [50, 72], grace: 10, perMonth: PER_MONTH.bimonth },
  year: { median: [350, 380], each: [340, 390], grace: 14, perMonth: PER_MONTH.year },
};

function nextMonthly(last: string, day: number): string {
  const y = +last.slice(0, 4);
  const m0 = +last.slice(5, 7); // 다음 달 (0-based 로 보면 +1)
  const ny = m0 === 12 ? y + 1 : y;
  const nm0 = m0 % 12;
  return iso(Date.UTC(ny, nm0, Math.min(day, lastDayOf(ny, nm0))));
}

export function detectRecurring(
  rows: RecurringInput[],
  today: string,
  opts: { ignore?: Set<string>; include?: Set<string>; memos?: Map<string, string> } = {},
): Recurring[] {
  const groups = new Map<string, RecurringInput[]>();
  for (const r of rows) {
    if (opts.ignore?.has(r.key)) continue;
    groups.set(r.key, [...(groups.get(r.key) ?? []), r]);
  }
  const out: Recurring[] = [];
  for (const [key, list] of groups) {
    const manual = opts.include?.has(key) ?? false;
    // 같은 날 여러 건은 하나로 (같은 날 나눠 결제 등)
    const byDate = new Map<string, RecurringInput[]>();
    for (const r of list) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
    const days = [...byDate.keys()].sort();
    if (days.length < (manual ? 2 : 3)) continue;
    const gaps = days.slice(1).map((d, i) => (t(d) - t(days[i]!)) / DAY);
    const g = median(gaps);
    const latestRow = list.find((r) => r.date === days[days.length - 1])!;
    const fixedCost = VARIABLE_GROUPS.has(latestRow.group ?? "") || VARIABLE_NAMES.test(key);
    // 공과금(가스·수도 등)은 내는 날이 들쭉날쭉해도 한두 달 간격으로 4번 이상이면 정기로 본다 (날짜 불규칙)
    const looseUtility = fixedCost && days.length >= 4 && g >= 26 && g <= 66 && gaps.every((x) => x >= 20 && x <= 75);
    const period =
      (Object.keys(RULES) as Period[]).find((p) => g >= RULES[p].median[0] && g <= RULES[p].median[1]) ??
      (looseUtility ? (g <= 45 ? "month" : "bimonth") : undefined);
    if (!period) continue;
    const rule = RULES[period];
    // 간격의 대부분(70%)이 범위 안이어야 한다 (가끔 건너뛴 달은 봐줌)
    const regular = gaps.filter((x) => x >= rule.each[0] && x <= rule.each[1]).length / gaps.length;
    const amounts = days.map((d) => byDate.get(d)!.reduce((s, r) => s + r.amount, 0));
    const mid = median(amounts);
    // 금액도 대부분 비슷해야 한다 (단골 가게를 정기 결제로 잡지 않게).
    // 다만 관리비·공과금처럼 금액이 매번 다른 고정비는 날짜가 아주 규칙적이면(80%, 4번 이상) 정기로 본다
    const steady = amounts.filter((a) => Math.abs(a - mid) <= mid * 0.25).length / amounts.length;
    const variable = steady < 0.7;
    const strict = regular >= (variable ? 0.8 : 0.7) && (!variable || (fixedCost && days.length >= 4));
    const irregular = !manual && !strict && looseUtility;
    if (!manual && !strict && !irregular) continue;
    const recent = amounts.slice(-3);
    const expected = variable ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : amounts[amounts.length - 1]!;

    const lastDate = days[days.length - 1]!;
    const lastAmount = amounts[amounts.length - 1]!;
    const prev = amounts[amounts.length - 2];
    let anchor: string;
    let nextDate: string;
    if (irregular) {
      // 날짜가 들쭉날쭉하면 마지막 날 + 보통 간격
      nextDate = iso(t(lastDate) + Math.round(g) * DAY);
      // 예전 화면(irregular 를 모르는)이 열려 있어도 매달 그날로 그리게 결제일 자리에 예상일의 날짜를 둔다
      anchor = String(+nextDate.slice(8, 10));
    } else if (period === "month" || period === "bimonth") {
      const dom = days.map((d) => +d.slice(8, 10));
      // 말일 근처(28일~)에 몰리면 말일로
      const day = Math.round(median(dom.map((d) => (d >= 28 ? 31 : d))));
      anchor = String(day);
      nextDate = nextMonthly(lastDate, day);
      if (period === "bimonth") nextDate = nextMonthly(nextDate, day);
    } else if (period === "week") {
      anchor = String((new Date(t(lastDate)).getUTCDay() + 6) % 7);
      nextDate = iso(t(lastDate) + 7 * DAY);
    } else {
      anchor = lastDate.slice(5);
      nextDate = `${+lastDate.slice(0, 4) + 1}-${anchor}`;
    }
    const overdue = (t(today) - t(nextDate)) / DAY;
    // 두 주기 넘게 안 나갔으면 끝난 것으로 보고 뺀다
    if (overdue > (irregular ? Math.round(g) + 14 : period === "year" ? 60 : period === "bimonth" ? 75 : period === "month" ? 45 : 14)) continue;
    const latest = list.find((r) => r.date === lastDate)!;
    // 합친 다른 이름으로 최근에 나갔어도 제목은 원래 이름 (없으면 최근 이름)
    const own = list.filter((r) => !r.merged).sort((a, b) => b.date.localeCompare(a.date))[0] ?? latest;
    out.push({
      key,
      name: own.name,
      kind: latest.kind,
      direction: latest.direction ?? "out",
      review: latest.review,
      period,
      anchor,
      count: days.length,
      lastDate,
      lastAmount,
      // 변동 금액은 매번 바뀌는 게 정상이라 '바뀜' 표시를 하지 않는다
      changedFrom: !variable && prev !== undefined && Math.abs(prev - lastAmount) > Math.max(1, prev * 0.01) ? prev : null,
      nextDate,
      missed: overdue > (irregular ? 14 : rule.grace),
      category: latest.category,
      monthly: Math.round((variable ? expected : mid) * (irregular ? 30.4 / g : rule.perMonth)),
      history: list.map((r) => ({ id: r.id, date: r.date, amount: r.amount, name: r.name })).sort((a, b) => b.date.localeCompare(a.date)),
      manual,
      plan: false,
      variable,
      irregular,
      gap: Math.round(g),
      shift: period !== "week" && !days.some(isOffDay) ? ((latest.direction ?? "out") === "in" ? "before" : "after") : null,
      expected,
      range: [Math.min(...recent), Math.max(...recent)],
      memo: opts.memos?.get(key) ?? null,
    });
  }
  return out.sort((a, b) => b.monthly - a.monthly);
}
