import { PER_MONTH, type Period, type Recurring } from "./recurring.ts";

/**
 * 직접 등록한 정기 결제.
 *
 * ## 왜 필요한가
 *
 * 정기 결제는 **실제 결제 내역에서 찾아내는** 것이라 같은 이름이 최소 두 번은 나와야 한다
 * (`recurring.ts` 의 `days.length < (manual ? 2 : 3)`). 1년에 한 번 나가는 돈(도메인 갱신·
 * 연간 구독)은 두 번째가 1년 뒤라, 그동안 어디에도 안 보인다. 잊어버리기 딱 좋다.
 *
 * 그래서 내역 없이도 손으로 등록할 수 있게 한다. 등록해 두면 정기 결제 목록에 뜨고,
 * **달력에도 '예정' 으로 저절로 뜬다**(`web/recurring.ts` 의 `plannedByDate` 가 정기 결제
 * 목록에서 뽑기 때문). 그래서 달력 일정으로 따로 만들 필요가 없다 — 그러면 같은 게 두 번 보인다.
 *
 * ## 어디에 저장하나
 *
 * `ledger_settings` 의 `recurring.plan.<이름>`. 값은 JSON 한 줄이다. 설정 값은 200자까지라
 * 짧게 유지한다. 이미 쓰고 있는 `recurring.ignore.*` · `recurring.memo.*` 와 같은 자리다.
 *
 * 이름을 열쇠로 쓰므로 **같은 이름으로 다시 등록하면 덮어쓴다**(중복이 쌓이지 않는다).
 */

export const PLAN_PREFIX = "recurring.plan.";

export interface Plan {
  name: string;
  /** 한 번에 나가는 돈 (양수) */
  amount: number;
  period: Period;
  /** 기준 결제일. 여기서부터 주기만큼 더해 가며 다음 날짜를 찾는다 */
  startDate: string;
  direction: "out" | "in";
  categoryId: number | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERIODS: Period[] = ["week", "month", "bimonth", "year"];
const DAY = 86_400_000;
const t = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const lastDayOf = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** 설정 한 줄 → 등록 내용. 모양이 깨졌으면 null (화면이 멈추느니 그것만 빠지는 게 낫다) */
export function parsePlan(name: string, raw: string): Plan | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const amount = typeof v.amount === "number" && Number.isFinite(v.amount) ? Math.round(Math.abs(v.amount)) : null;
  const period = PERIODS.find((p) => p === v.period);
  const startDate = typeof v.startDate === "string" && DATE.test(v.startDate) ? v.startDate : null;
  if (!name || amount === null || amount <= 0 || !period || !startDate) return null;
  return {
    name,
    amount,
    period,
    startDate,
    direction: v.direction === "in" ? "in" : "out",
    categoryId: typeof v.categoryId === "number" && Number.isInteger(v.categoryId) ? v.categoryId : null,
  };
}

/** 기준일에서 주기만큼 한 번 더한 날 (달 단위는 없는 날짜를 말일로 당긴다) */
function advance(date: string, period: Period): string {
  if (period === "week") return iso(t(date) + 7 * DAY);
  const months = period === "month" ? 1 : period === "bimonth" ? 2 : 12;
  const y = +date.slice(0, 4);
  const m0 = +date.slice(5, 7) - 1 + months;
  const day = +date.slice(8, 10);
  const ny = y + Math.floor(m0 / 12);
  const nm0 = ((m0 % 12) + 12) % 12;
  return iso(Date.UTC(ny, nm0, Math.min(day, lastDayOf(ny, nm0))));
}

/** 오늘 이후(오늘 포함)로 가장 가까운 결제일 */
export function nextOccurrence(plan: Plan, today: string): string {
  let date = plan.startDate;
  // 주마다라도 100번이면 2년치다. 기준일이 아주 옛날이어도 멈춘다
  for (let i = 0; i < 400 && date < today; i++) date = advance(date, plan.period);
  return date;
}

/**
 * 등록 내용 → 정기 결제 한 줄.
 *
 * 내역이 없으니 지난 기록에서 오는 값들은 비운다 — `count: 0`, `history: []`,
 * `changedFrom: null`, `missed: false`(냈는지 안 냈는지 알 길이 없어 '안 나감' 으로 겁주지 않는다).
 */
export function planToRecurring(plan: Plan, today: string, key: string, category: string | null): Recurring {
  const nextDate = nextOccurrence(plan, today);
  const anchor =
    plan.period === "year"
      ? nextDate.slice(5)
      : plan.period === "week"
        ? String((new Date(t(nextDate)).getUTCDay() + 6) % 7)
        : String(+nextDate.slice(8, 10));
  const gapDays = plan.period === "week" ? 7 : plan.period === "month" ? 30 : plan.period === "bimonth" ? 61 : 365;
  return {
    key,
    name: plan.name,
    kind: plan.direction === "in" ? "income" : "expense",
    direction: plan.direction,
    review: false,
    period: plan.period,
    anchor,
    count: 0,
    lastDate: plan.startDate,
    lastAmount: plan.amount,
    changedFrom: null,
    nextDate,
    missed: false,
    category,
    monthly: Math.round(plan.amount * PER_MONTH[plan.period]),
    history: [],
    manual: true,
    plan: true,
    variable: false,
    irregular: false,
    gap: gapDays,
    // 지난 기록이 없어서 쉬는 날에 나가는 돈인지 판단할 근거가 없다 — 당기거나 미루지 않는다
    shift: null,
    expected: plan.amount,
    range: [plan.amount, plan.amount],
    memo: null,
  };
}
