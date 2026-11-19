import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildBanksaladXlsx } from "./testing/fake-banksalad.ts";
import { banksaladParser as banksaladSource } from "./banksalad.ts";
import { classifyBanksalad } from "./banksalad-rules.ts";
import { ImportError } from "./types.ts";

const file = async (rows: Parameters<typeof buildBanksaladXlsx>[0]) => ({
  name: "fake.xlsx",
  bytes: await buildBanksaladXlsx(rows),
});

describe("banksaladSource", () => {
  it("detects the transaction sheet", async () => {
    expect(await banksaladSource.detect(await file([]))).toBe(true);

    const other = new ExcelJS.Workbook();
    other.addWorksheet("Sheet1").addRow(["a", "b"]);
    const bytes = new Uint8Array(await other.xlsx.writeBuffer());
    expect(await banksaladSource.detect({ name: "x.xlsx", bytes })).toBe(false);
    expect(await banksaladSource.detect({ name: "x.txt", bytes: new Uint8Array([1, 2, 3]) })).toBe(false);
  });

  it("parses rows into normalized transactions", async () => {
    const { transactions, skipped } = await banksaladSource.parse(
      await file([
        { date: "2026-03-14", time: "12:31:05", type: "지출", major: "식비", minor: "패스트푸드", merchant: "가짜버거", amount: -8900, method: "가짜카드A" },
        { date: "2026-03-14", type: "수입", major: "금융수입", merchant: "가짜은행 이자", amount: 120 },
        { date: "2026-03-15", time: "09:00:00", type: "이체", major: "이체", merchant: "홍길동", amount: 20000, memo: "밥값" },
      ]),
      {},
    );

    expect(skipped).toEqual([]);
    expect(transactions).toEqual([
      {
        kind: "expense",
        date: "2026-03-14",
        time: "12:31:05",
        merchant: "가짜버거",
        amount: -8900,
        paymentMethod: "가짜카드A",
        sourceCategory: { major: "식비", minor: "패스트푸드" },
      },
      {
        kind: "income",
        date: "2026-03-14",
        time: null,
        merchant: "가짜은행 이자",
        amount: 120,
        paymentMethod: "가짜카드",
        sourceCategory: { major: "금융수입", minor: "미분류" },
      },
      {
        kind: "transfer",
        date: "2026-03-15",
        time: "09:00:00",
        merchant: "홍길동",
        amount: 20000,
        paymentMethod: "가짜카드",
        sourceCategory: { major: "이체", minor: "미분류" },
        memo: "밥값",
      },
    ]);
  });

  it("treats salary deposits filed as transfers as income", async () => {
    const { transactions } = await banksaladSource.parse(
      await file([
        { date: "2026-03-25", type: "이체", major: "저축", merchant: "가짜회사 급여", amount: 3000000 },
        { date: "2026-03-25", type: "이체", major: "저축", merchant: "급여 반환", amount: -1000 },
      ]),
      {},
    );
    expect(transactions.map((t) => t.kind)).toEqual(["income", "transfer"]);
    expect(transactions[0]!.sourceCategory).toEqual({ major: "급여" });
  });

  it("treats utility bills paid by transfer as expenses", async () => {
    const { transactions } = await banksaladSource.parse(
      await file([
        { date: "2026-01-20", type: "이체", major: "내계좌이체", merchant: "한전(홍길동)", amount: -40000 },
        { date: "2026-01-21", type: "이체", major: "이체", merchant: "서울가스/집주인", amount: -20000 },
        { date: "2026-01-22", type: "이체", major: "미분류", merchant: "집주인(관리비)", amount: -100000 },
        { date: "2026-01-23", type: "이체", major: "이체", merchant: "가스 환급", amount: 5000 },
      ]),
      {},
    );
    expect(transactions.map((t) => [t.kind, t.sourceCategory])).toEqual([
      ["expense", { major: "주거/통신", minor: "전기세" }],
      ["expense", { major: "주거/통신", minor: "가스비" }],
      ["expense", { major: "주거/통신", minor: "관리비" }],
      ["transfer", { major: "이체", minor: "미분류" }],
    ]);
    expect(transactions.slice(0, 3).map((t) => classifyBanksalad(t).decision)).toEqual([
      "include",
      "include",
      "include",
    ]);
  });

  it("skips rows it cannot understand", async () => {
    const { transactions, skipped } = await banksaladSource.parse(
      await file([
        { date: "2026-03-14", type: "환전", merchant: "x", amount: -1 },
        { date: "2026-03-14", type: "지출", merchant: "x", amount: "1,000" },
        { date: "2026-03-14", type: "지출", merchant: "x", amount: -1, currency: "USD" },
      ]),
      {},
    );
    expect(transactions).toEqual([]);
    expect(skipped.map((s) => s.row)).toEqual(["2행", "3행", "4행"]);
  });

  it("reads the financial snapshot without personal details", async () => {
    const snapshot = await banksaladSource.readSnapshot!(await file([]));
    expect(snapshot).toEqual({
      creditScore: 900,
      assets: [
        { group: "자유입출금 자산", name: "가짜통장", amount: 1000 },
        { group: "자유입출금 자산", name: "가짜파킹", amount: 2000 },
      ],
      debts: [{ group: "장기대출", name: "가짜주택대출", amount: 100000000 }],
      loans: [
        { kind: "은행 대출", institution: "가짜공사", product: "가짜보금자리론", principal: 100000000, balance: 99990000, rate: 4, start: "2026-02-27", end: "2056-02-27" },
      ],
      investments: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("홍길동");
  });

  it("explains password-protected files", async () => {
    const encrypted = { name: "locked.xlsx", bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]) };
    await expect(banksaladSource.parse(encrypted, {})).rejects.toBeInstanceOf(ImportError);
  });

  it("classifies rows by Banksalad category and known non-transactions", () => {
    const tx = (major: string) => ({
      kind: "transfer" as const,
      date: "2026-01-01",
      time: null,
      merchant: "x",
      amount: -1,
      paymentMethod: "p",
      sourceCategory: { major },
    });
    expect(classifyBanksalad(tx("내계좌이체")).decision).toBe("exclude");
    expect(classifyBanksalad(tx("카드대금")).decision).toBe("exclude");
    // 저축·투자·현금 분류는 믿을 수 없어서 사용자 확인으로 보낸다
    expect(classifyBanksalad(tx("현금")).decision).toBe("review");
    expect(classifyBanksalad(tx("저축")).decision).toBe("review");
    expect(classifyBanksalad({ ...tx("저축"), merchant: "적금 입금" }).decision).toBe("exclude");
    expect(classifyBanksalad({ ...tx("현금"), merchant: "현대카드" }).decision).toBe("exclude");
    expect(classifyBanksalad(tx("이체")).decision).toBe("include");
    expect(classifyBanksalad(tx("미분류")).decision).toBe("review");
    expect(classifyBanksalad({ ...tx("미분류"), merchant: "차액" })).toEqual({
      decision: "exclude",
      reason: "잔액 차액 보정",
    });
    const atm = { ...tx("생활"), kind: "expense" as const, merchant: "CD현금지급" };
    expect(classifyBanksalad(atm).decision).toBe("exclude");
    expect(classifyBanksalad({ ...atm, merchant: "가짜식당" }).decision).toBe("include");
    expect(classifyBanksalad({ ...tx("미분류"), merchant: "연결계좌로 빼기" }).decision).toBe("exclude");
  });
});
