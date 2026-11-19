import type ExcelJS from "exceljs";
import { cellDate, cellText } from "./xlsx.ts";

/**
 * 뱅크샐러드 내보내기 첫 시트 `뱅샐현황`의 재무 정보.
 * 섹션 제목(예: "6.대출현황")과 그 두 줄 아래의 열 이름으로 위치를 찾는다. 이름·이메일은 읽지 않는다.
 */

export interface Holding {
  group: string;
  name: string;
  amount: number;
}

export interface Loan {
  kind: string;
  institution: string;
  product: string;
  principal: number;
  balance: number;
  /** 연 % */
  rate: number;
  start: string | null;
  end: string | null;
}

export interface Investment {
  kind: string;
  institution: string;
  product: string;
  principal: number;
  value: number;
}

export interface Snapshot {
  creditScore: number | null;
  assets: Holding[];
  debts: Holding[];
  loans: Loan[];
  investments: Investment[];
}

const SHEET = "뱅샐현황";
const num = (v: ExcelJS.CellValue) => (typeof v === "number" ? v : Number(cellText(v).replace(/[,\s원%]/g, "")) || 0);

export function readSnapshot(wb: ExcelJS.Workbook): Snapshot | null {
  const found = wb.getWorksheet(SHEET);
  if (!found) return null;
  const ws: ExcelJS.Worksheet = found;

  // 섹션 제목 줄 찾기: "3.재무현황" 같은 형태
  const sections = new Map<string, number>();
  ws.eachRow((row, r) => {
    for (let c = 1; c <= Math.min(ws.columnCount, 4); c++) {
      const m = cellText(row.getCell(c).value).match(/^\d+\.(.+)$/);
      if (m) sections.set(m[1]!.trim(), r);
    }
  });
  const sectionEnds = [...sections.values()].sort((a, b) => a - b);
  const endOf = (start: number) => sectionEnds.find((r) => r > start) ?? ws.rowCount + 1;

  /**
   * 섹션 안에서 열 이름이 있는 줄과 이름 → 열 번호 (같은 이름이 두 번 나오면 두 번째는 name#2).
   * 병합된 칸(예: '자산 | 부채' 띠)은 값이 반복돼 보이므로 꼭 있어야 할 열 이름으로 헤더 줄을 가린다.
   */
  function header(title: string, mustHave: string) {
    const start = sections.get(title);
    if (!start) return null;
    const end = endOf(start);
    for (let r = start + 1; r < Math.min(end, start + 4); r++) {
      const cols = new Map<string, number>();
      let previous = "";
      ws.getRow(r).eachCell((cell, c) => {
        const name = cellText(cell.value).replace(/\s+/g, "");
        // 병합된 칸은 같은 값이 이어져 나오므로 첫 칸만 쓴다
        if (!name || (name === previous && cell.isMerged)) return;
        previous = name;
        cols.set(cols.has(name) ? `${name}#2` : name, c);
      });
      if (cols.has(mustHave)) return { row: r, end, cols };
    }
    return null;
  }

  const rowsOf = (h: NonNullable<ReturnType<typeof header>>) => {
    const out: ExcelJS.Row[] = [];
    for (let r = h.row + 1; r < h.end; r++) out.push(ws.getRow(r));
    return out;
  };

  // 1. 고객정보: 신용점수만
  let creditScore: number | null = null;
  const profile = header("고객정보", "이름");
  if (profile) {
    const col = [...profile.cols].find(([name]) => name.startsWith("신용점수"))?.[1];
    if (col) creditScore = num(ws.getRow(profile.row + 1).getCell(col).value) || null;
  }

  // 3. 재무현황: 자산(항목·상품명·금액)과 부채(항목#2·상품명#2·금액#2), 항목은 병합돼 첫 줄에만 있다
  const assets: Holding[] = [];
  const debts: Holding[] = [];
  const fin = header("재무현황", "상품명");
  if (fin) {
    const read = (groupCol?: number, nameCol?: number, amountCol?: number, into?: Holding[]) => {
      if (!groupCol || !nameCol || !amountCol || !into) return;
      let group = "";
      for (const row of rowsOf(fin)) {
        const g = cellText(row.getCell(groupCol).value);
        if (/^총/.test(g) || /^순자산/.test(g)) break;
        if (g) group = g;
        const name = cellText(row.getCell(nameCol).value);
        if (name) into.push({ group, name, amount: num(row.getCell(amountCol).value) });
      }
    };
    read(fin.cols.get("항목"), fin.cols.get("상품명"), fin.cols.get("금액"), assets);
    read(fin.cols.get("항목#2"), fin.cols.get("상품명#2"), fin.cols.get("금액#2"), debts);
  }

  // 6. 대출현황
  const loans: Loan[] = [];
  const loan = header("대출현황", "대출종류");
  if (loan) {
    const c = (n: string) => loan.cols.get(n);
    for (const row of rowsOf(loan)) {
      const kind = cellText(row.getCell(c("대출종류") ?? 0).value);
      if (!kind || kind === "총계") break;
      loans.push({
        kind,
        institution: cellText(row.getCell(c("금융사") ?? 0).value),
        product: cellText(row.getCell(c("상품명") ?? 0).value),
        principal: num(row.getCell(c("대출원금") ?? 0).value),
        balance: num(row.getCell(c("대출잔액") ?? 0).value),
        rate: num(row.getCell(c("대출금리") ?? 0).value),
        start: cellDate(row.getCell(c("대출신규일") ?? 0).value),
        end: cellDate(row.getCell(c("대출만기일") ?? 0).value),
      });
    }
  }

  // 5. 투자현황
  const investments: Investment[] = [];
  const inv = header("투자현황", "투자상품종류");
  if (inv) {
    const c = (n: string) => inv.cols.get(n);
    for (const row of rowsOf(inv)) {
      const kind = cellText(row.getCell(c("투자상품종류") ?? 0).value);
      if (!kind || kind === "총계") break;
      investments.push({
        kind,
        institution: cellText(row.getCell(c("금융사") ?? 0).value),
        product: cellText(row.getCell(c("상품명") ?? 0).value),
        principal: num(row.getCell(c("투자원금") ?? 0).value),
        value: num(row.getCell(c("평가금액") ?? 0).value),
      });
    }
  }

  return { creditScore, assets, debts, loans, investments };
}
