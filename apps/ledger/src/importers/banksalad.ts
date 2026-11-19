import type ExcelJS from "exceljs";
import { readSnapshot } from "./banksalad-snapshot.ts";
import { cellDate, cellText, cellTime, loadWorkbook } from "./xlsx.ts";
import type { ImportFile, ImportParser, NormalizedTransaction, ParseResult, TransactionKind } from "./types.ts";

/**
 * 뱅크샐러드 "데이터 내보내기" 엑셀 읽기 (브라우저에서 실행).
 * 거래는 시트 `가계부 내역`에서, 재무 스냅샷(자산·부채·대출·투자·신용점수)은 `뱅샐현황`에서 읽는다.
 * `뱅샐현황`의 이름·이메일은 읽지 않는다.
 */
const SHEET = "가계부 내역";
const HEADER = ["날짜", "시간", "타입", "대분류", "소분류", "내용", "금액", "화폐", "결제수단", "메모"];

const KINDS: Record<string, TransactionKind> = {
  지출: "expense",
  수입: "income",
  이체: "transfer",
};

/**
 * 공과금을 이체로 낸 건은 지출로 본다. 뱅크샐러드가 이체로 분류하고, 본인 이름이 들어간
 * 가상계좌 납부(예: '한전(홍길동)')는 '내계좌이체'로까지 분류해서 빠지는 일이 있다.
 * 카테고리는 뱅크샐러드가 공과금 지출에 쓰는 이름에 맞춘다.
 */
const UTILITY_TRANSFERS: { pattern: RegExp; minor: string }[] = [
  { pattern: /^한전|한국전력/, minor: "전기세" },
  { pattern: /가스/, minor: "가스비" },
  { pattern: /관리비/, minor: "관리비" },
];
const UTILITY_MAJOR = "주거/통신";

/** 내용에 이 말이 있는 입금 이체는 수입(급여)으로 본다. 뱅크샐러드가 급여를 '저축'으로 분류하는 경우가 있다 */
const SALARY_KEYWORD = "급여";

function findSheet(wb: ExcelJS.Workbook): ExcelJS.Worksheet | undefined {
  const ws = wb.getWorksheet(SHEET);
  if (!ws) return undefined;
  const header = ws.getRow(1);
  const ok = HEADER.every((h, i) => cellText(header.getCell(i + 1).value) === h);
  return ok ? ws : undefined;
}

export const banksaladParser: ImportParser = {
  id: "banksalad-xlsx",
  label: "뱅크샐러드 내보내기 (xlsx)",

  async detect(file: ImportFile) {
    try {
      return findSheet(await loadWorkbook(file)) !== undefined;
    } catch {
      return false;
    }
  },

  async parse(file: ImportFile): Promise<ParseResult> {
    const ws = findSheet(await loadWorkbook(file));
    if (!ws) return { transactions: [], skipped: [{ row: "-", reason: `'${SHEET}' 시트가 없어요` }] };

    const transactions: NormalizedTransaction[] = [];
    const skipped: ParseResult["skipped"] = [];

    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cell = (col: number) => row.getCell(col).value;
      if (!row.hasValues) continue;

      const skip = (reason: string) => skipped.push({ row: `${r}행`, reason });
      const date = cellDate(cell(1));
      if (!date) {
        skip("날짜를 읽을 수 없음");
        continue;
      }
      const kind = KINDS[cellText(cell(3))];
      if (!kind) {
        skip(`알 수 없는 타입 '${cellText(cell(3))}'`);
        continue;
      }
      const amount = cell(7);
      if (typeof amount !== "number" || !Number.isInteger(amount)) {
        skip("금액이 정수가 아님");
        continue;
      }
      const currency = cellText(cell(8));
      if (currency && currency !== "KRW") {
        skip(`원화가 아닌 거래 (${currency})`);
        continue;
      }

      const time = cellTime(cell(2));
      const minor = cellText(cell(5));
      const memo = cellText(cell(10));
      const merchant = cellText(cell(6)) || "(내용 없음)";
      const isSalary = kind === "transfer" && amount > 0 && merchant.includes(SALARY_KEYWORD);
      const utility =
        kind === "transfer" && amount < 0 ? UTILITY_TRANSFERS.find((u) => u.pattern.test(merchant)) : undefined;
      const sourceCategory = isSalary
        ? { major: "급여" }
        : utility
          ? { major: UTILITY_MAJOR, minor: utility.minor }
          : { major: cellText(cell(4)), ...(minor ? { minor } : {}) };
      transactions.push({
        kind: isSalary ? "income" : utility ? "expense" : kind,
        date,
        time: time === "00:00:00" ? null : time,
        merchant,
        amount,
        paymentMethod: cellText(cell(9)),
        // 급여·공과금으로 바꾼 건은 뱅크샐러드의 이체 분류 대신 해당 카테고리로 둔다
        sourceCategory,
        ...(memo ? { memo } : {}),
      });
    }
    return { transactions, skipped };
  },

  async readSnapshot(file: ImportFile) {
    return readSnapshot(await loadWorkbook(file));
  },
};
