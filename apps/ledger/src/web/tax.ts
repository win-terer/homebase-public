import type { Transaction } from "./api.ts";

/**
 * 연말정산 신용카드 등 소득공제 추정 (근로소득자, 2026년 귀속 기준으로 가정).
 * 실제 공제액은 국세청 자료(카드사 집계, 가맹점 업종 등)로 정해지므로 어디까지나 추정치다.
 *
 * - 총급여의 25%(최저사용금액)를 넘게 쓴 금액부터 공제
 * - 공제율: 신용카드 15%, 체크카드·현금영수증 30%, 도서·공연 등 30%(총급여 7천만원 이하), 전통시장·대중교통 40%
 * - 최저사용금액은 공제율이 낮은 것부터 차감 (신용 → 체크·문화 → 전통시장·대중교통)
 * - 기본 한도: 총급여 7천만원 이하 300만원 / 초과 250만원
 * - 추가 한도(전통시장·대중교통·문화분): 7천만원 이하 300만원 / 초과 200만원
 */

export type PaymentType = "credit" | "debit" | "none";

export const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  credit: "신용카드",
  debit: "체크카드·현금영수증",
  none: "공제 안 됨",
};

/** 결제수단 이름으로 구분 추측. 사용자가 바꿀 수 있다 */
export function guessPaymentType(method: string): PaymentType {
  if (/체크/.test(method)) return "debit";
  // 계좌 출금·간편결제 머니/포인트는 연결 수단에 따라 달라서 기본은 제외 (사용자가 지정)
  // 현금영수증으로 추가된 지출은 현금영수증 합계로 따로 계산하므로 여기서는 제외
  if (/통장|예금|계좌|페이|머니|포인트|간편결제|현금영수증/.test(method)) return "none";
  return "credit";
}

/** 카드로 내도 공제 대상이 아닌 것 (통신요금·관리비·공과금·보험료·세금·상품권 등) */
const EXCLUDED_CATEGORY = /^(관리비|전기세|가스비|수도세|휴대폰|인터넷|통신비|보험|세금)$/;
const EXCLUDED_MERCHANT = /통신요금|인터넷제휴|관리비|한국전력|한전|도시가스|보험|국세|지방세|상품권|하이패스/;
const TRANSIT = /티머니|캐시비|교통카드|지하철|코레일|고속버스|시외버스|SRT/i;
const MARKET = /전통시장|재래시장/;
const CULTURE = /교보문고|영풍문고|예스24|yes24|알라딘|서점|CGV|메가박스|롯데시네마|박물관|미술관|공연/i;

export interface Usage {
  credit: number;
  debit: number;
  culture: number;
  market: number;
  transit: number;
  /** 카드로 냈지만 공제 대상 아님 */
  excluded: number;
  /** 계좌·페이 등 공제 안 되는 수단 */
  none: number;
}

export function classifyUsage(txs: Transaction[], typeOf: (method: string) => PaymentType, salary: number): Usage {
  const u: Usage = { credit: 0, debit: 0, culture: 0, market: 0, transit: 0, excluded: 0, none: 0 };
  for (const t of txs) {
    if (t.kind !== "expense") continue;
    const spend = -t.amount; // 환불은 음수로 들어와 상쇄
    const type = typeOf(t.paymentMethod ?? "");
    if (type === "none") u.none += spend;
    else if (EXCLUDED_CATEGORY.test(t.category ?? "") || EXCLUDED_MERCHANT.test(t.merchant)) u.excluded += spend;
    else if (TRANSIT.test(t.merchant)) u.transit += spend;
    else if (MARKET.test(t.merchant)) u.market += spend;
    else if (salary <= 70_000_000 && CULTURE.test(t.merchant)) u.culture += spend;
    else u[type] += spend;
  }
  return u;
}

export interface TaxEstimate {
  salary: number;
  threshold: number;
  /** 공제 대상 사용액 합계 */
  eligible: number;
  remainingToThreshold: number;
  basicLimit: number;
  addLimit: number;
  /** 한도 적용 전 공제 가능 금액 */
  deductible: number;
  /** 기본 한도 안의 공제 */
  general: number;
  /** 전통시장·대중교통·문화 추가 공제 */
  extra: number;
  total: number;
  /** 기본 한도까지 남은 공제 */
  remainingLimit: number;
  /** 지금부터 100만원 더 쓸 때 늘어나는 공제 (한도 반영) */
  per1m: { credit: number; debit: number };
}

export function estimateDeduction(u: Usage, salary: number): TaxEstimate {
  const threshold = Math.round(salary * 0.25);
  const low = salary <= 70_000_000;
  const basicLimit = low ? 3_000_000 : 2_500_000;
  const addLimit = low ? 3_000_000 : 2_000_000;
  const C = Math.max(0, u.credit), D = Math.max(0, u.debit), K = Math.max(0, u.culture), M = Math.max(0, u.market), T = Math.max(0, u.transit);
  const eligible = C + D + K + M + T;

  const raw = C * 0.15 + (D + K) * 0.3 + (M + T) * 0.4;
  // 최저사용금액을 공제율 낮은 순서로 차감
  let rest = threshold;
  let thresholdCut = 0;
  for (const [amount, rate] of [[C, 0.15], [D + K, 0.3], [M + T, 0.4]] as const) {
    const take = Math.min(rest, amount);
    thresholdCut += take * rate;
    rest -= take;
  }
  const deductible = Math.max(0, raw - thresholdCut);
  const general = Math.min(deductible, basicLimit);
  // 추가 공제: 기본 한도를 넘는 부분 중 전통시장·대중교통·문화분까지, 추가 한도 안에서
  const extraBase = M * 0.4 + T * 0.4 + K * 0.3;
  const extra = Math.min(Math.max(0, deductible - basicLimit), extraBase, addLimit);
  const remainingLimit = Math.max(0, basicLimit - general);

  const gain = (amount: number, rate: number) => {
    const aboveThreshold = Math.max(0, amount - Math.max(0, threshold - eligible));
    return Math.round(Math.min(aboveThreshold * rate, remainingLimit));
  };
  return {
    salary,
    threshold,
    eligible,
    remainingToThreshold: Math.max(0, threshold - eligible),
    basicLimit,
    addLimit,
    deductible: Math.round(deductible),
    general: Math.round(general),
    extra: Math.round(extra),
    total: Math.round(general + extra),
    remainingLimit: Math.round(remainingLimit),
    per1m: { credit: gain(1_000_000, 0.15), debit: gain(1_000_000, 0.3) },
  };
}

/* ── 연말정산 예상 환급 ─────────────────────────────────────── */

/** 2026년 근로자 4대보험 요율 (본인 부담분) */
const RATES = { pension: 0.0475, pensionCap: 6_370_000, health: 0.03595, care: 0.1314, employ: 0.009 };
/** 장기주택저당차입금 이자 공제 한도 (15년 이상, 고정금리 또는 비거치식 분할상환) */
export const MORTGAGE_LIMIT = 18_000_000;

/** 근로소득공제 */
export function earnedIncomeDeduction(salary: number): number {
  const d =
    salary <= 5_000_000 ? salary * 0.7
    : salary <= 15_000_000 ? 3_500_000 + (salary - 5_000_000) * 0.4
    : salary <= 45_000_000 ? 7_500_000 + (salary - 15_000_000) * 0.15
    : salary <= 100_000_000 ? 12_000_000 + (salary - 45_000_000) * 0.05
    : 14_750_000 + (salary - 100_000_000) * 0.02;
  return Math.min(d, 20_000_000);
}

/** 종합소득세 기본세율 (과세표준 × 세율 - 누진공제) */
export function incomeTax(base: number): number {
  const brackets: [number, number, number][] = [
    [14_000_000, 0.06, 0],
    [50_000_000, 0.15, 1_260_000],
    [88_000_000, 0.24, 5_760_000],
    [150_000_000, 0.35, 15_440_000],
    [300_000_000, 0.38, 19_940_000],
    [500_000_000, 0.4, 25_940_000],
    [1_000_000_000, 0.42, 35_940_000],
    [Infinity, 0.45, 65_940_000],
  ];
  const [, rate, cut] = brackets.find(([upTo]) => base <= upTo)!;
  return Math.max(0, base * rate - cut);
}

/** 근로소득세액공제 (한도 포함) */
export function earnedIncomeCredit(calc: number, salary: number): number {
  const credit = calc <= 1_300_000 ? calc * 0.55 : 715_000 + (calc - 1_300_000) * 0.3;
  const limit =
    salary <= 33_000_000 ? 740_000
    : salary <= 70_000_000 ? Math.max(740_000 - (salary - 33_000_000) * 0.008, 660_000)
    : salary <= 120_000_000 ? Math.max(660_000 - (salary - 70_000_000) * 0.5, 500_000)
    : Math.max(500_000 - (salary - 120_000_000) * 0.5, 200_000);
  return Math.min(credit, limit);
}

export interface RefundInput {
  salary: number;
  /** 매달 원천징수되는 소득세 (지방소득세 제외) */
  withheldMonthly: number;
  /** 본인 외 기본공제 대상 부양가족 수 */
  dependents: number;
  /** 신용카드 등 소득공제액 */
  cardDeduction: number;
  /** 장기주택저당차입금 이자 (0 이면 공제 안 받음) */
  mortgageInterest: number;
  /** 보장성 보험료 연간 납입액 */
  insurance: number;
}

export interface RefundEstimate {
  earnedDeduction: number;
  earnedIncome: number;
  deductions: { basic: number; pension: number; health: number; employ: number; card: number; mortgage: number; total: number };
  base: number;
  calc: number;
  credits: { earned: number; standard: number; insurance: number; total: number };
  determined: number;
  withheld: number;
  /** 돌려받을 돈 (소득세 + 지방소득세). 음수면 더 내야 함 */
  refund: number;
}

export function estimateRefund(i: RefundInput): RefundEstimate {
  const monthly = i.salary / 12;
  const pension = Math.round(Math.min(monthly, RATES.pensionCap) * RATES.pension) * 12;
  const healthMonthly = Math.round(monthly * RATES.health);
  const health = (healthMonthly + Math.round(healthMonthly * RATES.care)) * 12;
  const employ = Math.round(monthly * RATES.employ) * 12;
  const basic = 1_500_000 * (1 + Math.max(0, i.dependents));
  const mortgage = Math.min(Math.max(0, i.mortgageInterest), MORTGAGE_LIMIT);

  const earnedDeduction = earnedIncomeDeduction(i.salary);
  const earnedIncome = Math.max(0, i.salary - earnedDeduction);
  const totalDeductions = basic + pension + health + employ + i.cardDeduction + mortgage;
  const base = Math.max(0, earnedIncome - totalDeductions);
  const calc = incomeTax(base);

  const earned = earnedIncomeCredit(calc, i.salary);
  const insurance = Math.min(Math.max(0, i.insurance), 1_000_000) * 0.12;
  // 표준세액공제(13만원)는 주택자금 등 특별소득공제·특별세액공제를 신청하지 않을 때만. 유리한 쪽을 고른다
  const standard = mortgage > 0 ? 0 : insurance > 130_000 ? 0 : 130_000;
  const special = standard ? 0 : insurance;
  const determined = Math.max(0, calc - earned - standard - special);
  const withheld = i.withheldMonthly * 12;

  return {
    earnedDeduction: Math.round(earnedDeduction),
    earnedIncome: Math.round(earnedIncome),
    deductions: { basic, pension, health, employ, card: i.cardDeduction, mortgage, total: Math.round(totalDeductions) },
    base: Math.round(base),
    calc: Math.round(calc),
    credits: { earned: Math.round(earned), standard, insurance: Math.round(special), total: Math.round(earned + standard + special) },
    determined: Math.round(determined),
    withheld,
    refund: Math.round((withheld - determined) * 1.1),
  };
}

/** 대출 스냅샷으로 올해 낼 이자 추정: 잔액 × 금리 × 올해 상환 횟수 (대출 다음 달부터 매달) */
export function estimateMortgageInterest(loan: { balance: number; rate: number; start: string | null }, year: string): number {
  if (!loan.start) return 0;
  const [sy, sm] = loan.start.split("-").map(Number) as [number, number];
  const y = Number(year);
  const firstMonth = sy === y ? sm + 1 : sy < y ? 1 : 13;
  const payments = Math.max(0, 12 - firstMonth + 1);
  return Math.round(loan.balance * (loan.rate / 100 / 12) * payments);
}

/** 이자 공제 대상일 가능성이 있는 대출 (상환 기간 15년 이상) */
export function isLongTermMortgage(loan: { start: string | null; end: string | null }): boolean {
  if (!loan.start || !loan.end) return false;
  return Number(loan.end.slice(0, 4)) - Number(loan.start.slice(0, 4)) >= 15;
}

const dayNo = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;
const fromDayNo = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

/**
 * 연말까지 늘려 잡기 위한 비율. asOf 는 기록이 있는 마지막 날 (가져오기가 늦으면 오늘보다 이르다).
 * 최근 3달(91일) 쓴 만큼을 남은 날에 한 번 더 쓴다고 보고, 최근 기록 × remainingRatio 를 더한다.
 */
export function yearEndProjection(year: string, asOf: string): { recentFrom: string; remainingRatio: number; elapsedRatio: number } {
  const start = dayNo(`${year}-01-01`);
  const end = dayNo(`${year}-12-31`);
  const now = Math.min(Math.max(dayNo(asOf), start - 1), end);
  if (now < start) return { recentFrom: `${year}-01-01`, remainingRatio: 0, elapsedRatio: 0 };
  const from = Math.max(start, now - 90);
  const remaining = end - now;
  return { recentFrom: fromDayNo(from), remainingRatio: remaining / (now - from + 1), elapsedRatio: remaining / (now - start + 1) };
}

/** 사용액에 최근 사용액 × ratio 를 더한다 */
export function addUsage(u: Usage, recent: Usage, ratio: number): Usage {
  const out = { ...u };
  for (const k of Object.keys(out) as (keyof Usage)[]) out[k] = Math.round(u[k] + recent[k] * ratio);
  return out;
}
