/**
 * 폰 알림 원문 → 거래 한 건.
 *
 * ## 무엇을 위한 것인가
 *
 * 뱅샐 엑셀은 **내보내기를 눌러야** 들어온다. 그 사이에도 오늘 쓴 돈이 보이게 하려고,
 * 카드사 앱 알림을 바로 거래로 만든다. 다만 이렇게 만든 건 **임시**다(`source = 'notify'`):
 * 나중에 엑셀이 그 기간을 덮을 때 지우고 확정 데이터로 바꾼다.
 *
 * ## 왜 임시여야 하나
 *
 * 알림에는 없는 게 많다 — 카테고리, 할부 상세, 취소 반영. 가맹점 이름도 실제와 다르다
 * (네이버페이로 긁으면 "네이버파이낸셜(주)" 로 온다. 엑셀에는 진짜 가게 이름이 찍힌다).
 * 폰이 꺼져 있으면 **조용히 빠지기도 한다.** 그래서 엑셀을 대신할 수는 없고, 그 사이를 메울 뿐이다.
 *
 * ## 모르면 null
 *
 * 광고·잔액 안내처럼 거래가 아닌 알림이 훨씬 많다. 억지로 읽어내려 하지 않는다 —
 * 틀린 거래가 들어가는 게 빈 화면보다 나쁘다.
 */

export interface ParsedNotification {
  /** 취소도 `expense` 다 — 금액 부호만 바뀐다(아래 참고) */
  kind: "expense";
  /** YYYY-MM-DD (Asia/Seoul) */
  date: string;
  /** HH:MM:SS */
  time: string;
  merchant: string;
  /** 원. 결제는 음수, 취소는 양수 */
  amount: number;
  /** 카드 이름 등 */
  paymentMethod: string | null;
}

const won = (s: string) => Number(s.replace(/,/g, ""));

/**
 * 알림에는 연도가 없다. 받은 날을 기준으로 채우되, 연말연시에 한 해가 어긋나지 않게 맞춘다.
 *
 * 12/31 결제 알림을 1/1 에 받으면 올해로 찍혀 **1년 앞선 날짜**가 된다. 이틀 넘게 앞서면
 * 작년으로 본다(이틀은 시계 오차·알림 지연 몫).
 */
function yearFor(month: number, day: number, receivedSeoul: string): number {
  const y = +receivedSeoul.slice(0, 4);
  const guess = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return guess > addDays(receivedSeoul, 2) ? y - 1 : y;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * 현대카드 앱 알림.
 *
 * ```
 * 홍길동 님, 현대 ZERO 승인
 * 17,500원 일시불, 10/3 11:09
 * 네이버파이낸셜(주)
 * 누적1,000,000원
 * ```
 *
 * 제목·부제는 비어 있고 본문에 다 온다. 줄 순서에 기대지 않고 **생긴 모양으로** 찾는다 —
 * 할부 표기나 줄 수가 바뀌어도 버티게.
 */
function parseHyundai(text: string, receivedSeoul: string): ParsedNotification | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const joined = lines.join("\n");
  if (!/승인|취소/.test(joined)) return null;

  // `17,500원 일시불, 10/3 11:09`
  const m = joined.match(/([\d,]+)원[^\n,]*,\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const amount = won(m[1]!);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const month = +m[2]!;
  const day = +m[3]!;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = `${yearFor(month, day, receivedSeoul)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const time = `${String(+m[4]!).padStart(2, "0")}:${m[5]}:00`;

  // 가맹점: 금액 줄 **다음** 줄부터, 누적 금액·안내 문구가 아닌 첫 줄
  const amountLine = lines.findIndex((l) => l.includes(m[1]!));
  const merchant = lines
    .slice(amountLine + 1)
    .find((l) => !/^누적/.test(l) && !/^\d[\d,]*원$/.test(l) && l.length > 1);
  if (!merchant) return null;

  // 카드 이름: `… 현대 ZERO 승인` 에서 '님,' 뒤 ~ '승인/취소' 앞
  const card = joined.match(/님,\s*(.+?)\s*(승인|취소)/)?.[1]?.trim() ?? null;
  /**
   * 취소는 **수입이 아니라 지출의 환불**이다 — `kind: "expense"` 에 양수 금액.
   *
   * 뱅샐 엑셀도 취소를 그렇게 적고, 화면은 그 모양을 전제로 짜여 있다: 같은 날 같은 가게
   * 같은 금액의 결제·환불 짝은 달력에서 원래 줄에 취소선만 긋고 환불 줄은 숨긴다
   * (`web/api.ts` 의 `pairCancels`). 수입으로 넣으면 그 짝이 안 맞아서 "+17,500 수입" 이
   * 따로 보이고, 월 수입 합계까지 올라간다.
   */
  const cancelled = /취소/.test(joined);

  return {
    kind: "expense",
    date,
    time,
    merchant,
    amount: cancelled ? amount : -amount,
    paymentMethod: card,
  };
}

/**
 * 단축어가 보내는 `sentAt` 을 서울 날짜·시각으로. 모르는 모양이면 null.
 *
 * iOS 단축어의 '알림 날짜' 는 기기 언어대로 찍혀 온다 — 한국어 폰이면
 * `2026년 10월 3일 오후 12시 42분 43초 GMT+9`. ISO(`2026-10-03T03:42:45Z`, `2026-10-03 12:42`)도 받는다.
 */
export function seoulFromSentAt(sentAt: string | null | undefined): { date: string; time: string } | null {
  if (!sentAt) return null;
  const ko = sentAt.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2})시\s*(\d{1,2})분(?:\s*(\d{1,2})초)?/);
  if (ko) {
    let h = +ko[5]! % 12;
    if (ko[4] === "오후") h += 12;
    const pad = (v: string | number) => String(+v).padStart(2, "0");
    return { date: `${ko[1]}-${pad(ko[2]!)}-${pad(ko[3]!)}`, time: `${pad(h)}:${pad(ko[6]!)}:${pad(ko[7] ?? 0)}` };
  }
  const iso = sentAt.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!iso) return null;
  if (!iso[4]) return { date: iso[1]!, time: `${iso[2]}:${iso[3] ?? "00"}` }; // 시간대 표시가 없으면 서울 시각으로 본다
  const d = new Date(`${iso[1]}T${iso[2]}:${iso[3] ?? "00"}${iso[4]}`);
  if (Number.isNaN(d.getTime())) return null;
  const seoul = new Date(d.getTime() + 9 * 3_600_000).toISOString();
  return { date: seoul.slice(0, 10), time: seoul.slice(11, 19) };
}

/**
 * 토스 앱 알림 (토스에 연결한 카드로 결제하면 토스가 대신 알려 준다).
 *
 * ```
 * 제목: 2,900원 결제
 * 본문: ○○카드 | ○○커피_0(일시불)
 * ```
 *
 * 현대카드와 달리 **본문에 시각이 없다** — 단축어가 붙여 보낸 알림 시각(`sentAt`)을 쓰고,
 * 그것도 못 읽으면 받은 시각으로 둔다. 가맹점 뒤 `(일시불)`·`(3개월)` 은 떼고, `|` 앞은 카드다.
 * 송금·입금·광고는 제목에 '결제' 가 없어 그냥 null.
 */
function parseToss(
  n: { title: string | null; subtitle: string | null; body: string | null },
  when: { date: string; time: string },
): ParsedNotification | null {
  const title = n.title ?? "";
  // 제목이 아니라 본문에 금액이 올 때도 대비한다 (한 덩어리 text 로 왔을 때)
  const head = /결제/.test(title) ? title : [n.title, n.subtitle, n.body].filter(Boolean).join("\n");
  const m = head.match(/([\d,]+)원\s*결제/);
  if (!m) return null;
  const amount = won(m[1]!);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cancelled = /취소/.test(head);

  const detail = (n.body && n.body !== title ? n.body : (n.subtitle ?? "")).trim();
  const [first, ...rest] = detail.split("|").map((p) => p.trim());
  const card = rest.length ? (first ?? null) : null;
  const merchantRaw = rest.length ? rest.join(" | ") : (first ?? "");
  const merchant = merchantRaw.replace(/\s*\((?:일시불|\d+\s*개월)\)\s*$/, "").trim();
  if (!merchant) return null;

  return { kind: "expense", date: when.date, time: when.time, merchant, amount: cancelled ? amount : -amount, paymentMethod: card || null };
}

/**
 * 앱 이름으로 갈라서 읽는다. 읽을 수 없으면 null — 광고·잔액 안내가 훨씬 많다.
 *
 * `receivedSeoul` 은 서울 기준 오늘(YYYY-MM-DD). 알림에 연도가 없어서 필요하다.
 * `sentAt` 은 단축어가 붙인 알림 시각 — 본문에 시각이 없는 앱(토스)이 쓴다. `nowTime` 은 그마저 없을 때의 시각.
 */
export function parseNotification(
  n: { app: string | null; title: string | null; subtitle: string | null; body: string | null },
  receivedSeoul: string,
  opts: { sentAt?: string | null; nowTime?: string } = {},
): ParsedNotification | null {
  const text = [n.title, n.subtitle, n.body].filter(Boolean).join("\n");
  if (!text.trim()) return null;
  if (n.app?.includes("현대")) return parseHyundai(text, receivedSeoul);
  if (n.app?.includes("토스") || n.app?.toLowerCase().includes("toss")) {
    return parseToss(n, seoulFromSentAt(opts.sentAt) ?? { date: receivedSeoul, time: opts.nowTime ?? "00:00:00" });
  }
  // IBK·케이뱅크는 아직 — 실제 문구를 보고 나서 붙인다
  return null;
}
