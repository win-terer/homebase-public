import { ImportError } from "./types.ts";

/**
 * 현금영수증 목록 CSV 읽기 (브라우저에서 실행).
 *
 * 형식: homebase 가 정한 CSV (UTF-8, 첫 줄 헤더). 홈택스 사용내역 화면의 열 이름을 그대로 쓴다.
 *   거래일시,가맹점명,사용금액,승인번호[,거래구분][,발행구분]
 *   2026-01-04 00:50:16,주식회사 가짜엔터,10000,730000000,승인거래,일반거래
 * 거래구분이 '취소거래'면 취소, 발행구분에 '도서'가 있으면 도서·공연비로 본다.
 */

export interface CashReceipt {
  approvalNo: string;
  date: string;
  time: string | null;
  merchant: string;
  /** 원. 취소는 음수 */
  amount: number;
  kind: "general" | "culture";
}

const REQUIRED = ["거래일시", "가맹점명", "사용금액", "승인번호"] as const;

/** 따옴표를 지원하는 최소 CSV 파서 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

export function parseCashReceiptCsv(text: string): { receipts: CashReceipt[]; skipped: { row: string; reason: string }[] } {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const header = (rows[0] ?? []).map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  if (REQUIRED.some((h) => col(h) < 0)) {
    throw new ImportError(`현금영수증 CSV 헤더가 필요해요: ${REQUIRED.join(", ")}`);
  }
  const receipts: CashReceipt[] = [];
  const skipped: { row: string; reason: string }[] = [];
  rows.slice(1).forEach((r, i) => {
    const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? "").trim() : "");
    const label = `${i + 2}행`;
    const m = get("거래일시").match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}:\d{2}))?$/);
    if (!m) return skipped.push({ row: label, reason: "거래일시 형식" });
    const amount = Number(get("사용금액").replace(/[,원\s]/g, ""));
    if (!Number.isInteger(amount) || amount === 0) return skipped.push({ row: label, reason: "사용금액" });
    const approvalNo = get("승인번호");
    if (!approvalNo) return skipped.push({ row: label, reason: "승인번호 없음" });
    const cancelled = get("거래구분").includes("취소");
    receipts.push({
      approvalNo,
      date: m[1]!,
      time: !m[2] || m[2] === "00:00:00" ? null : m[2],
      merchant: get("가맹점명") || "(가맹점 없음)",
      amount: cancelled ? -Math.abs(amount) : Math.abs(amount),
      kind: get("발행구분").includes("도서") ? "culture" : "general",
    });
  });
  return { receipts, skipped };
}
