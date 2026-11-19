import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { parseCashReceiptCsv } from "../importers/cash-receipt-csv.ts";
import { cashReceiptSummary, commitCashReceipts, planCashReceipts } from "./cash-receipts.ts";
import { ImportError } from "../importers/types.ts";

const CSV = `거래일시,가맹점명,사용금액,승인번호,거래구분,발행구분
2026-01-04 00:50:16,주식회사 가짜엔터,"10,000",A1,승인거래,일반거래
2026-01-06 00:00:00,가짜쇼핑 주식회사,24900,A2,승인거래,일반거래
2026-01-06 18:03:14,주식회사 가짜렌털케어,17800,A3,승인거래,일반거래
2026-01-10 12:00:00,가짜식당,30000,A4,승인거래,일반거래
2026-01-11 09:00:00,"가짜극장(주), 본점",22000,A5,승인거래,도서.공연비등
2026-01-12 09:00:00,가짜식당,5000,A6,취소거래,일반거래
2026-01-06 10:00:00,가짜판매자,7700,A7,승인거래,일반거래
`;

let db: SqliteDb;
beforeEach(() => {
  db = openMigratedSqlite();
  const add = db.raw.prepare(
    "INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, payment_method, source) VALUES (?, 'active', ?, NULL, ?, ?, ?, 'test')",
  );
  add.run("expense", "2026-01-04", "주식회사 가짜", -10000, "카카오페이 간편결제"); // 같은 날 간편결제 → 연결
  add.run("expense", "2026-01-06", "가짜쇼핑 주식회사", -24900, "가짜카드ZERO"); // 신용카드 → 연결 안 됨
  add.run("transfer", "2026-01-20", "주식회사 가짜렌털케", -17800, "입출금통장"); // 2주 뒤 자동이체, 잘린 이름 → 연결
  add.run("transfer", "2026-01-25", "다른사람", -30000, "가짜통장"); // 이름도 다르고 15일 뒤 → 연결 안 됨
  add.run("expense", "2025-12-28", "토스쇼핑", -7700, "토스 간편결제"); // 쇼핑 플랫폼 결제 9일 뒤 구매확정 발급 → 연결
});

describe("parseCashReceiptCsv", () => {
  it("reads the homebase CSV format", () => {
    const { receipts, skipped } = parseCashReceiptCsv(`﻿${CSV}`);
    expect(skipped).toEqual([]);
    expect(receipts[0]).toEqual({ approvalNo: "A1", date: "2026-01-04", time: "00:50:16", merchant: "주식회사 가짜엔터", amount: 10000, kind: "general" });
    expect(receipts[1]!.time).toBeNull();
    expect(receipts[4]).toMatchObject({ merchant: "가짜극장(주), 본점", kind: "culture" });
    expect(receipts[5]!.amount).toBe(-5000);
  });

  it("rejects files without the required header", () => {
    expect(() => parseCashReceiptCsv("a,b\n1,2")).toThrow(ImportError);
  });
});

describe("planCashReceipts", () => {
  it("links receipts to non-credit payments and adds the rest", async () => {
    const plan = await planCashReceipts(db, parseCashReceiptCsv(CSV).receipts);
    expect(plan.map((p) => [p.receipt.approvalNo, p.outcome, p.match?.merchant ?? null])).toEqual([
      ["A1", "existing", "주식회사 가짜"],
      ["A2", "added", null],
      ["A3", "existing", "주식회사 가짜렌털케"],
      ["A4", "added", null],
      ["A5", "added", null],
      ["A6", "cancelled", null],
      ["A7", "existing", "토스쇼핑"],
    ]);
  });

  it("stores receipts once and counts them for the tax summary", async () => {
    const receipts = parseCashReceiptCsv(CSV).receipts;
    expect(await commitCashReceipts(db, await planCashReceipts(db, receipts))).toEqual({ stored: 7, added: 3 });
    expect((await planCashReceipts(db, receipts)).every((p) => p.outcome === "duplicate")).toBe(true);
    expect(await cashReceiptSummary(db, "2026")).toEqual({ count: 7, total: 107400, culture: 22000 });
    const added = db.raw.prepare("SELECT merchant, amount, payment_method AS pm FROM ledger_transactions WHERE source = 'cash-receipt' ORDER BY id").all();
    expect(added).toEqual([
      { merchant: "가짜쇼핑 주식회사", amount: -24900, pm: "현금영수증" },
      { merchant: "가짜식당", amount: -30000, pm: "현금영수증" },
      { merchant: "가짜극장(주), 본점", amount: -22000, pm: "현금영수증" },
    ]);
  });
});
