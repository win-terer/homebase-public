import { describe, expect, it } from "vitest";
import { parseNotification, seoulFromSentAt } from "./notify-parse.ts";

/** 실제로 온 알림과 **같은 모양**, 값은 가짜 */
const 현대 = (body: string) => ({ app: "현대카드", title: null, subtitle: null, body });

describe("현대카드 알림 읽기", () => {
  it("승인 알림에서 거래를 만든다", () => {
    const got = parseNotification(
      현대("홍길동 님, 현대 ZERO 승인 \n12,000원 일시불, 10/3 11:09 \n가짜상점(주) \n누적1,000,000원"),
      "2026-10-03",
    );
    expect(got).toEqual({
      kind: "expense",
      date: "2026-10-03",
      time: "11:09:00",
      merchant: "가짜상점(주)",
      amount: -12000,
      paymentMethod: "현대 ZERO",
    });
  });

  it("취소는 지출의 환불이다 (수입이 아니다 — 원래 결제와 짝지어 취소선이 그어지게)", () => {
    const got = parseNotification(현대("홍길동 님, 현대 ZERO 승인취소 \n12,000원 일시불, 10/3 11:09 \n가짜상점(주)"), "2026-10-03");
    expect(got?.kind).toBe("expense");
    expect(got?.amount).toBe(12000);
  });

  it("할부도 읽는다", () => {
    expect(parseNotification(현대("홍길동 님, 현대 ZERO 승인 \n240,000원 3개월, 10/3 11:09 \n가짜가전"), "2026-10-03")?.amount).toBe(-240000);
  });

  it("누적 금액을 가맹점으로 착각하지 않는다", () => {
    expect(parseNotification(현대("홍길동 님, 현대 ZERO 승인 \n12,000원 일시불, 10/3 11:09 \n누적1,000,000원"), "2026-10-03")).toBeNull();
  });

  it("연말에 받은 작년 결제는 작년으로", () => {
    // 12/31 결제를 1/1 에 받았다 — 올해로 두면 1년 앞선 날짜가 된다
    expect(parseNotification(현대("홍길동 님, 현대 ZERO 승인 \n12,000원 일시불, 12/31 23:50 \n가짜상점"), "2027-01-01")?.date).toBe("2026-12-31");
  });

  it("하루 늦게 온 알림은 올해 그대로 (시계 오차로 작년이 되면 안 된다)", () => {
    expect(parseNotification(현대("홍길동 님, 현대 ZERO 승인 \n12,000원 일시불, 10/4 09:00 \n가짜상점"), "2026-10-03")?.date).toBe("2026-10-04");
  });

  it("거래가 아닌 알림은 읽지 않는다", () => {
    expect(parseNotification(현대("이번 달 혜택을 확인해보세요"), "2026-10-03")).toBeNull();
    expect(parseNotification(현대("홍길동 님, 현대 ZERO 승인 \n금액을 못 읽는 문구"), "2026-10-03")).toBeNull();
  });

  it("아직 모르는 앱은 건드리지 않는다", () => {
    expect(parseNotification({ app: "케이뱅크", title: null, subtitle: null, body: "12,000원 승인, 10/3 11:09 \n가짜" }, "2026-10-03")).toBeNull();
  });

  it("빈 알림은 null", () => {
    expect(parseNotification({ app: "현대카드", title: null, subtitle: null, body: null }, "2026-10-03")).toBeNull();
  });
});

describe("토스 알림 읽기", () => {
  const 토스 = (title: string | null, body: string | null) => ({ app: "토스", title, subtitle: null, body });
  const SENT = "2026년 10월 3일 오후 12시 42분 43초 GMT+9";

  it("제목의 금액 + 본문의 카드 | 가맹점(일시불), 시각은 sentAt 에서", () => {
    const got = parseNotification(토스("2,900원 결제", "가짜카드 | 가짜커피_0(일시불)"), "2026-10-03", { sentAt: SENT });
    expect(got).toEqual({ kind: "expense", date: "2026-10-03", time: "12:42:43", merchant: "가짜커피_0", amount: -2900, paymentMethod: "가짜카드" });
  });

  it("취소는 양수 금액(환불)", () => {
    expect(parseNotification(토스("2,900원 결제 취소", "가짜카드 | 가짜커피(일시불)"), "2026-10-03", { sentAt: SENT })?.amount).toBe(2900);
  });

  it("할부 표기도 뗀다", () => {
    expect(parseNotification(토스("300,000원 결제", "가짜카드 | 가짜가전(3개월)"), "2026-10-03", { sentAt: SENT })?.merchant).toBe("가짜가전");
  });

  it("sentAt 을 못 읽으면 받은 날 + nowTime", () => {
    const got = parseNotification(토스("2,900원 결제", "가짜카드 | 가짜커피"), "2026-10-03", { sentAt: "어제쯤", nowTime: "13:00:05" });
    expect(got?.date).toBe("2026-10-03");
    expect(got?.time).toBe("13:00:05");
  });

  it("카드 구분자가 없으면 본문 전체가 가맹점", () => {
    expect(parseNotification(토스("2,900원 결제", "가짜커피(일시불)"), "2026-10-03")).toMatchObject({ merchant: "가짜커피", paymentMethod: null, time: "00:00:00" });
  });

  it("결제가 아닌 알림(송금·광고)은 null", () => {
    expect(parseNotification(토스("3,000원 보냈어요", "가짜 님에게"), "2026-10-03", { sentAt: SENT })).toBeNull();
    expect(parseNotification(토스("오늘의 혜택", "포인트를 받아 가세요"), "2026-10-03", { sentAt: SENT })).toBeNull();
    expect(parseNotification(토스("2,900원 결제", ""), "2026-10-03", { sentAt: SENT })).toBeNull();
  });
});

describe("sentAt 읽기", () => {
  it("한국어 폰 표기", () => {
    expect(seoulFromSentAt("2026년 10월 3일 오후 12시 42분 43초 GMT+9")).toEqual({ date: "2026-10-03", time: "12:42:43" });
    expect(seoulFromSentAt("2026년 1월 5일 오전 12시 3분 7초 GMT+9")).toEqual({ date: "2026-01-05", time: "00:03:07" });
    expect(seoulFromSentAt("2026년 1월 5일 오후 11시 59분 GMT+9")).toEqual({ date: "2026-01-05", time: "23:59:00" });
  });
  it("ISO — Z 는 서울로 바꾸고, 시간대가 없으면 서울로 본다", () => {
    expect(seoulFromSentAt("2026-10-03T03:42:45.485Z")).toEqual({ date: "2026-10-03", time: "12:42:45" });
    expect(seoulFromSentAt("2026-10-02T16:30:00Z")).toEqual({ date: "2026-10-03", time: "01:30:00" });
    expect(seoulFromSentAt("2026-10-03 11:00")).toEqual({ date: "2026-10-03", time: "11:00:00" });
  });
  it("모르는 모양은 null", () => {
    expect(seoulFromSentAt(null)).toBeNull();
    expect(seoulFromSentAt("어제")).toBeNull();
  });
});
