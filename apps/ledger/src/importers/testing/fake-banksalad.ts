import ExcelJS from "exceljs";

/** 테스트용 가짜 뱅크샐러드 내보내기 행. 실제 데이터는 절대 쓰지 않는다. */
export interface FakeRow {
  date: string; // YYYY-MM-DD
  time?: string; // HH:mm:ss, 생략하면 00:00:00
  type: string; // 지출 | 수입 | 이체
  major?: string;
  minor?: string;
  merchant: string;
  amount: number | string;
  currency?: string;
  method?: string;
  memo?: string;
}

const HEADER = ["날짜", "시간", "타입", "대분류", "소분류", "내용", "금액", "화폐", "결제수단", "메모"];

/** `뱅샐현황` 시트를 실제와 같은 배치(섹션 제목, 설명, 헤더, 병합 칸)로 채운다. 값은 전부 가짜 */
function fillSummarySheet(ws: ExcelJS.Worksheet) {
  const put = (addr: string, v: ExcelJS.CellValue) => (ws.getCell(addr).value = v);
  put("B3", "1.고객정보");
  put("B4", "사용자의 기본 정보에 해당하는 항목입니다.");
  ["이름", "성별", "연령\n(만 나이)", "신용점수\n(KCB)", "이메일"].forEach((h, i) => put(`${"BCDEF"[i]}5`, h));
  ["홍길동", "남", 30, 900, "-"].forEach((v, i) => put(`${"BCDEF"[i]}6`, v));
  put("B9", "3.재무현황");
  put("B10", "데이터를 내보낸 시점의 자산과 부채 상태를 분석합니다.");
  put("B11", "자산");
  ws.mergeCells("B11:E11");
  put("F11", "부채");
  ws.mergeCells("F11:I11");
  ["항목", "상품명", "", "금액", "항목", "상품명", "", "금액"].forEach((h, i) => h && put(`${"BCDEFGHI"[i]}12`, h));
  put("B13", "자유입출금 자산");
  ws.mergeCells("B13:B14");
  put("C13", "가짜통장");
  put("E13", 1000);
  put("C14", "가짜파킹");
  put("E14", 2000);
  put("F13", "장기대출");
  put("G13", "가짜주택대출");
  put("I13", 100000000);
  put("B15", "총자산");
  put("B18", "6.대출현황");
  put("B19", "사용자가 보유한 대출상품 현황을 분석합니다.");
  ["대출종류", "금융사", "상품명", "", "대출원금", "대출잔액", "대출금리", "대출신규일", "대출만기일"].forEach((h, i) => h && put(`${"BCDEFGHIJ"[i]}20`, h));
  put("B21", "은행 대출");
  put("C21", "가짜공사");
  put("D21", "가짜보금자리론");
  put("F21", 100000000);
  put("G21", 99990000);
  put("H21", 4);
  put("I21", new Date(Date.UTC(2026, 1, 27)));
  put("J21", new Date(Date.UTC(2056, 1, 27)));
  put("B22", "총계");
}

/** 뱅크샐러드 내보내기와 같은 구조의 xlsx 를 메모리에서 만든다 */
export async function buildBanksaladXlsx(rows: FakeRow[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  fillSummarySheet(wb.addWorksheet("뱅샐현황"));
  const ws = wb.addWorksheet("가계부 내역");
  ws.addRow(HEADER);
  for (const r of rows) {
    const [y, m, d] = r.date.split("-").map(Number) as [number, number, number];
    const [hh, mm, ss] = (r.time ?? "00:00:00").split(":").map(Number) as [number, number, number];
    const row = ws.addRow([
      new Date(Date.UTC(y, m - 1, d)),
      new Date(Date.UTC(1899, 11, 30, hh, mm, ss)),
      r.type,
      r.major ?? "미분류",
      r.minor ?? "미분류",
      r.merchant,
      r.amount,
      r.currency ?? "KRW",
      r.method ?? "가짜카드",
      r.memo ?? null,
    ]);
    row.getCell(1).numFmt = "yyyy-mm-dd";
    row.getCell(2).numFmt = "hh:mm:ss";
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
