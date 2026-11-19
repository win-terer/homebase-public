/**
 * **간편결제로 낸 한 건이 두 줄로 들어오는 것**을 찾아낸다.
 *
 * 네이버페이로 롯데카드를 긁으면 뱅크샐러드에 네이버페이 쪽 기록과 카드사 쪽 기록이 **둘 다**
 * 들어온다. 같은 돈인데 지출이 두 배로 잡힌다 (사용자 신고 2026-10-06).
 *
 * ## 어느 쪽을 남기나 — 카드 줄
 *
 * 연말정산 추정(`web/tax.ts`)이 `간편결제` 가 붙은 결제수단을 이미 공제 대상에서 빼고 있다.
 * 그래서 지금은 **공제는 맞고 지출 합계만 두 배**다. 간편결제 줄을 빼면 공제는 그대로 두고
 * 합계만 바로잡힌다. 반대로 카드 줄을 빼면 공제가 줄어든다.
 * 대신 카드 줄 날짜는 **매입일**이라 하루 이틀 늦을 수 있다(실측 6건 중 2건).
 *
 * ## 어떻게 묶나
 *
 * 금액이 같고(부호까지) 한쪽은 간편결제·다른 쪽은 카드인 것 중에서, 둘 중 하나면 묶는다.
 *
 * - **이름이 닮았고 날짜가 사흘 안쪽**. 시각은 보지 않는다 — 결제는 1분 차이로 같은 날
 *   들어오지만 취소는 네이버 쪽이 10/2, 카드 쪽이 10/3 이고 카드 줄엔 시각이 아예 없었다(매입일).
 * - **같은 날 10분 안쪽이면 이름은 안 본다.** 같은 코레일인데 한쪽은 `한국철도공사`,
 *   다른 쪽은 `철도승차권발매` 로 들어온 짝이 실제로 있었다(2분 차, 같은 금액).
 *   1,649건에 이름을 아예 빼고 돌려도 나오는 짝이 **이 하나뿐**이라, 같은 날 같은 금액이
 *   10분 안에 양쪽에서 찍히는 건 사실상 한 결제다.
 *
 * 짝은 **1:1** 이다. 취소가 1인씩 쪼개져 같은 시각·같은 금액 두 줄로 들어오는 일이 실제로
 * 있어서(사용자 사례), 카드 줄 하나가 간편결제 줄 둘을 먹어 버리면 안 된다.
 *
 * 1년치 1,653건에 돌려 6쌍이 나왔고 전부 진짜 중복이었다 — 헛걸림 0.
 *
 * ## 충전금 줄도 같은 일을 한다 (2026-11-12)
 *
 * 카카오페이로 내면 `카카오페이 간편결제` 와 `카카오페이 머니` 가 **같은 초에 같은 금액**으로
 * 둘 다 들어온다. 위 규칙은 한쪽이 **카드**일 때만 봐서 이걸 못 걸렀고 같은 결제가 두 번 잡혀
 * 있었다. 그래서 시각이 초까지 같은 `간편결제 ↔ 페이 머니` 짝도 중복으로 보고 충전금 줄을 뺀다.
 *
 * 네이버페이의 `네이버페이 간편결제(머니)` 는 여기 안 걸린다 — 그건 **나눠 낸 한 조각**이고
 * 금액이 서로 다르다. 나눠 낸 것은 지우지 않고 화면에서 한 줄로 묶는다(`web/split-pay.ts`).
 */

/** 묶을 수 있는 최소한의 거래 모양 (가져오는 중인 행과 이미 저장된 행 양쪽에 맞춘다) */
export interface PayRow {
  date: string;
  /** `HH:MM[:SS]`. 카드 매입 줄에는 없을 수 있다 */
  time?: string | null;
  merchant: string;
  amount: number;
  paymentMethod: string | null;
}

/** 간편결제 결제수단인가 — "네이버페이 간편결제(포인트)"·"카카오페이 머니"·"토스 간편결제" */
export function isSimplePay(method: string | null | undefined): boolean {
  const m = method ?? "";
  return /간편결제|페이\s*머니/.test(m);
}

/**
 * **충전금 계좌 이름인가** — `카카오페이 머니` 처럼 결제수단 이름이 통째로 충전금인 것.
 *
 * 네이버페이의 `네이버페이 간편결제(머니)` 는 여기 안 걸린다(괄호 안이 꼬리표다). 그쪽은
 * 포인트·머니·카드로 **나눠 낸 한 조각**이라 멀쩡한 줄이고, 지우면 금액이 모자라게 된다.
 */
export function isPayMoney(method: string | null | undefined): boolean {
  return /페이\s*머니\s*$/.test(method ?? "");
}

/**
 * 카드로 낸 것인가. 간편결제가 아니고 카드 이름으로 보이는 것만 — 통장·예금은 짝이 아니다
 * (같은 날 같은 금액의 계좌 이체와 엮이면 엉뚱한 걸 지운다).
 */
export function isCard(method: string | null | undefined): boolean {
  const m = method ?? "";
  if (!m || isSimplePay(m)) return false;
  return /카드|LOCA|Edition|ONE\b/i.test(m);
}

/** 괄호 안(=`(승차권발매)` 같은 꼬리표)과 공백을 떼어 낸 가게 이름 */
function bareName(name: string): string {
  return name.replace(/\([^)]*\)/g, "").replace(/[\s_·-]/g, "");
}

/** 한쪽이 다른 쪽으로 시작하면 같은 가게로 본다 ("한국철도공사" ↔ "한국철도공사(승차권발매)") */
function sameShop(a: string, b: string): boolean {
  const [x, y] = [bareName(a), bareName(b)];
  return Boolean(x) && Boolean(y) && (x.startsWith(y) || y.startsWith(x));
}

/** 같은 날 이만큼 안쪽이면 이름이 달라도 한 결제로 본다 (분) */
const SAME_MOMENT_MINUTES = 10;

const clockMinutes = (time: string | null | undefined) =>
  time && /^\d{2}:\d{2}/.test(time) ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) : null;

/** 같은 날, 시각이 10분 안쪽 — 이름이 서로 다르게 들어온 짝을 위한 뒷문 */
function sameMoment(a: PayRow, b: PayRow): boolean {
  if (a.date !== b.date) return false;
  const [x, y] = [clockMinutes(a.time), clockMinutes(b.time)];
  return x !== null && y !== null && Math.abs(x - y) <= SAME_MOMENT_MINUTES;
}

const DAY = 86_400_000;
const apart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;

/** 날짜가 이만큼 안쪽이면 같은 결제로 본다 — 카드 매입이 늦어지는 폭(실측 최대 2일) */
export const WITHIN_DAYS = 3;

/**
 * 간편결제 줄 하나하나에 짝이 되는 카드 줄을 찾는다.
 *
 * `rows` 안에서 서로 짝을 짓는다. 돌려주는 것은 **간편결제 쪽 인덱스** — 빼야 할 줄이다.
 * 날짜가 가까운 것부터 가져간다(같은 날 짝이 있으면 그쪽이 먼저).
 */
export function simplePayTwins<T extends PayRow>(rows: readonly T[]): { pay: number; card: number }[] {
  const taken = new Set<number>(); // 남기는 쪽으로 이미 쓴 줄
  const dropped = new Set<number>(); // 빼기로 한 줄
  const found: { pay: number; card: number }[] = [];
  const pays = rows.map((r, i) => ({ r, i })).filter(({ r }) => isSimplePay(r.paymentMethod));
  // 날짜 순으로 봐야 어느 간편결제 줄이 먼저 짝을 가져갈지가 입력 순서에 흔들리지 않는다
  pays.sort((a, b) => a.r.date.localeCompare(b.r.date) || a.i - b.i);

  const cards = rows.map((r, i) => ({ r, i })).filter(({ r }) => isCard(r.paymentMethod));
  for (const { r: pay, i } of pays) {
    let best: { card: number; gap: number } | null = null;
    for (const { r: card, i: j } of cards) {
      if (taken.has(j) || card.amount !== pay.amount) continue;
      const gap = apart(card.date, pay.date);
      if (gap > WITHIN_DAYS) continue;
      if (!sameShop(pay.merchant, card.merchant) && !sameMoment(pay, card)) continue;
      if (!best || gap < best.gap) best = { card: j, gap };
    }
    if (best) {
      taken.add(best.card);
      dropped.add(i);
      found.push({ pay: i, card: best.card });
    }
  }

  /**
   * **충전금 줄이 결제 줄을 또 적은 것**(2026-11-12). 카카오페이로 한 번 결제하면 `카카오페이
   * 간편결제` 와 `카카오페이 머니` 두 줄이 **같은 초에 같은 금액**으로 들어온다. 위 짝짓기는
   * 한쪽이 **카드**일 때만 봐서 이걸 못 걸렀고, 실제로 두 번 잡힌 결제가 있었다.
   *
   * 여기서는 시각이 **초까지 같을 때만** 묶는다. 카드 매입처럼 날짜가 밀리는 일이 없고(같은
   * 지갑 안에서 같은 순간에 적히는 두 줄이다), 느슨하게 잡으면 나눠 낸 조각을 지울 수 있다.
   * 빼는 쪽은 **충전금 줄** — 결제 줄이 가게·분류를 들고 있다.
   */
  const stamp = (r: PayRow) => `${r.date} ${r.time ?? ""}`;
  for (const { r: money, i } of pays) {
    if (dropped.has(i) || taken.has(i) || !isPayMoney(money.paymentMethod) || !money.time) continue;
    const twin = pays.find(
      ({ r, i: j }) =>
        j !== i &&
        !dropped.has(j) &&
        !taken.has(j) &&
        !isPayMoney(r.paymentMethod) &&
        r.amount === money.amount &&
        Boolean(r.time) &&
        stamp(r) === stamp(money) &&
        sameShop(r.merchant, money.merchant),
    );
    if (!twin) continue;
    taken.add(twin.i);
    dropped.add(i);
    found.push({ pay: i, card: twin.i });
  }
  return found;
}

/** 제외 사유 — 가져오기 요약과 정리 화면이 같은 말을 쓴다 */
export const SIMPLE_PAY_REASON = "간편결제 중복";
