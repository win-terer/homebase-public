import { describe, expect, it } from "vitest";
import { isCard, isPayMoney, isSimplePay, simplePayTwins, type PayRow } from "./simple-pay.ts";

const row = (date: string, merchant: string, amount: number, paymentMethod: string): PayRow => ({ date, merchant, amount, paymentMethod });

const NAVER = "네이버페이 간편결제";
const KAKAO = "카카오페이 간편결제";
const KAKAO_MONEY = "카카오페이 머니";
const at = (date: string, time: string, merchant: string, amount: number, paymentMethod: string): PayRow => ({ date, time, merchant, amount, paymentMethod });
const LOCA = "LOCA 가짜카드";

describe("결제수단 가리기", () => {
  it("간편결제", () => {
    expect(isSimplePay(NAVER)).toBe(true);
    expect(isSimplePay("네이버페이 간편결제(포인트)")).toBe(true);
    expect(isSimplePay("카카오페이 머니")).toBe(true);
    expect(isSimplePay(LOCA)).toBe(false);
    expect(isSimplePay(null)).toBe(false);
  });
  it("카드 — 통장·예금은 아니다", () => {
    expect(isCard(LOCA)).toBe(true);
    expect(isCard("가짜카드 Edition3")).toBe(true);
    expect(isCard("가짜카드")).toBe(true);
    expect(isCard("가짜통장")).toBe(false);
    expect(isCard("보통예금(가짜은행통장)")).toBe(false);
    expect(isCard(NAVER)).toBe(false);
  });
  it("충전금 — 네이버페이의 (머니) 꼬리표는 나눠 낸 조각이라 아니다", () => {
    expect(isPayMoney(KAKAO_MONEY)).toBe(true);
    expect(isPayMoney("네이버페이 간편결제(머니)")).toBe(false);
    expect(isPayMoney(NAVER)).toBe(false);
    expect(isPayMoney(null)).toBe(false);
  });
});

describe("간편결제 ↔ 충전금 중복", () => {
  it("같은 초·같은 금액·같은 가게면 충전금 줄을 뺀다", () => {
    const rows = [at("2026-10-02", "10:30:00", "주식회사 가짜상사", -15000, KAKAO), at("2026-10-02", "10:30:00", "주식회사 가짜상사", -15000, KAKAO_MONEY)];
    expect(simplePayTwins(rows)).toEqual([{ pay: 1, card: 0 }]);
  });
  it("금액이 다르면 나눠 낸 것 — 건드리지 않는다", () => {
    const rows = [at("2026-10-02", "10:30:00", "가게", -10000, KAKAO), at("2026-10-02", "10:30:00", "가게", -5000, KAKAO_MONEY)];
    expect(simplePayTwins(rows)).toEqual([]);
  });
  it("시각이 1초라도 다르면 다른 결제", () => {
    const rows = [at("2026-10-02", "10:30:00", "가게", -15000, KAKAO), at("2026-10-02", "10:30:01", "가게", -15000, KAKAO_MONEY)];
    expect(simplePayTwins(rows)).toEqual([]);
  });
  it("네이버페이 포인트·머니로 나눠 낸 줄은 지우지 않는다", () => {
    const rows = [
      at("2026-10-05", "11:30:00", "가짜버거", -2000, "네이버페이 간편결제(포인트)"),
      at("2026-10-05", "11:30:00", "가짜버거", -8000, "네이버페이 간편결제(머니)"),
    ];
    expect(simplePayTwins(rows)).toEqual([]);
  });
  it("시각이 없으면 묶지 않는다", () => {
    const rows = [row("2026-10-02", "가게", -15000, KAKAO), row("2026-10-02", "가게", -15000, KAKAO_MONEY)];
    expect(simplePayTwins(rows)).toEqual([]);
  });
});

describe("간편결제 ↔ 카드 짝 찾기 (실제로 들어온 모양)", () => {
  it("같은 날 1분 차이 결제", () => {
    const rows = [row("2026-10-01", "한국철도공사(승차권발매)", -20000, LOCA), row("2026-10-01", "한국철도공사", -20000, NAVER)];
    expect(simplePayTwins(rows)).toEqual([{ pay: 1, card: 0 }]);
  });

  it("취소는 날짜가 다르고 카드 줄엔 시각이 없다 — 그래도 묶인다", () => {
    const rows = [row("2026-10-02", "한국철도공사", 10000, NAVER), row("2026-10-03", "한국철도공사(승차권발매)", 10000, LOCA)];
    expect(simplePayTwins(rows)).toEqual([{ pay: 0, card: 1 }]);
  });

  it("쪼개진 취소 둘은 카드 줄 둘과 1:1 로 묶인다", () => {
    const rows = [
      row("2026-10-02", "한국철도공사", 10000, NAVER),
      row("2026-10-02", "한국철도공사", 10000, NAVER),
      row("2026-10-03", "한국철도공사(승차권발매)", 10000, LOCA),
      row("2026-10-03", "한국철도공사(승차권발매)", 10000, LOCA),
    ];
    expect(simplePayTwins(rows)).toHaveLength(2);
  });

  it("카드 줄이 하나면 간편결제 줄 하나만 가져간다", () => {
    const rows = [
      row("2026-10-02", "한국철도공사", 10000, NAVER),
      row("2026-10-02", "한국철도공사", 10000, NAVER),
      row("2026-10-03", "한국철도공사(승차권발매)", 10000, LOCA),
    ];
    expect(simplePayTwins(rows)).toHaveLength(1);
  });

  it("매입이 이틀 밀린 것도 묶인다", () => {
    const rows = [row("2026-10-01", "가짜커피 가짜지점", -3300, NAVER), row("2026-10-03", "가짜커피 가짜지점", -3300, "가짜카드 Edition3")];
    expect(simplePayTwins(rows)).toHaveLength(1);
  });
});

describe("엉뚱한 것은 묶지 않는다", () => {
  const cases: [string, PayRow[]][] = [
    ["가게가 다르면", [row("2026-10-01", "스타벅스", -3300, NAVER), row("2026-10-01", "투썸플레이스", -3300, LOCA)]],
    ["금액이 다르면", [row("2026-10-01", "한국철도공사", -3300, NAVER), row("2026-10-01", "한국철도공사", -3400, LOCA)]],
    ["부호가 다르면(결제와 취소)", [row("2026-10-01", "한국철도공사", -3300, NAVER), row("2026-10-01", "한국철도공사", 3300, LOCA)]],
    ["나흘 넘게 떨어지면", [row("2026-10-01", "한국철도공사", -3300, NAVER), row("2026-10-05", "한국철도공사", -3300, LOCA)]],
    ["둘 다 간편결제면", [row("2026-10-01", "한국철도공사", -3300, NAVER), row("2026-10-01", "한국철도공사", -3300, "카카오페이 간편결제")]],
    ["짝이 통장이면", [row("2026-10-01", "한국철도공사", -3300, NAVER), row("2026-10-01", "한국철도공사", -3300, "가짜통장")]],
  ];
  for (const [name, rows] of cases) it(name, () => expect(simplePayTwins(rows)).toEqual([]));
});

describe("이름이 다르게 들어온 짝 — 같은 날 10분 안쪽이면 묶는다", () => {
  const at = (date: string, time: string, merchant: string, amount: number, paymentMethod: string): PayRow => ({ date, time, merchant, amount, paymentMethod });

  it("한국철도공사 ↔ 철도승차권발매 (실제로 들어온 모양, 2분 차)", () => {
    const rows = [
      at("2026-10-10", "10:10:00", "철도승차권발매", -30000, "가짜카드 Edition3"),
      at("2026-10-10", "10:12:00", "한국철도공사", -30000, NAVER),
    ];
    expect(simplePayTwins(rows)).toEqual([{ pay: 1, card: 0 }]);
  });

  it("같은 날이어도 10분을 넘으면 이름이 다르면 안 묶는다", () => {
    const rows = [
      at("2026-10-10", "10:00:00", "철도승차권발매", -30000, "가짜카드 Edition3"),
      at("2026-10-10", "10:12:00", "한국철도공사", -30000, NAVER),
    ];
    expect(simplePayTwins(rows)).toEqual([]);
  });

  it("날짜가 다르면 이름이 달라서는 안 묶는다 (매입일 뒷문을 이름 없이 열어 주지 않는다)", () => {
    const rows = [
      at("2026-10-11", "10:10:00", "철도승차권발매", -30000, "가짜카드 Edition3"),
      at("2026-10-10", "10:12:00", "한국철도공사", -30000, NAVER),
    ];
    expect(simplePayTwins(rows)).toEqual([]);
  });
});
