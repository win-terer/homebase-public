import ExcelJS from "exceljs";
import { ImportError, type ImportFile } from "./types.ts";

/** 암호화된 Office 파일은 zip 이 아닌 CFB 컨테이너(D0 CF 11 E0)로 저장된다 */
function isEncryptedOffice(bytes: Uint8Array): boolean {
  return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

export async function loadWorkbook(file: ImportFile): Promise<ExcelJS.Workbook> {
  if (isEncryptedOffice(file.bytes)) {
    throw new ImportError(
      "비밀번호가 걸린 엑셀은 아직 지원하지 않아요. 엑셀에서 비밀번호를 해제하고 다시 올려주세요.",
    );
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file.bytes.slice().buffer as ArrayBuffer);
  } catch {
    throw new ImportError("엑셀(xlsx) 파일을 읽을 수 없어요.");
  }
  return wb;
}

/** 셀 값을 문자열로. 서식 있는 텍스트·하이퍼링크 셀도 처리한다 */
export function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if ("richText" in value) return value.richText.map((t) => t.text).join("").trim();
  if ("text" in value) return String(value.text).trim();
  if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
  return "";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 날짜 셀 → "YYYY-MM-DD". exceljs 는 엑셀 날짜를 UTC 기준 Date 로 준다 */
export function cellDate(value: ExcelJS.CellValue): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

/** 시각 셀 → "HH:mm:ss" */
export function cellTime(value: ExcelJS.CellValue): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}
