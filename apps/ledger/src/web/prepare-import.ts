/**
 * 가져올 파일을 브라우저에서 읽는다. 원본 파일은 서버로 보내지 않고, 거래 목록(JSON)과 파일 해시만 보낸다.
 * 엑셀 라이브러리가 커서 가져오기 화면에서만 불러온다 (`import("./prepare-import.ts")`).
 */
import { parseCashReceiptCsv } from "../importers/cash-receipt-csv.ts";
import { sha256Bytes, withDedupeKeys } from "../importers/dedupe.ts";
import { detectParser } from "../importers/registry.ts";
import { SIMPLE_PAY_REASON, simplePayTwins } from "../importers/simple-pay.ts";
import type { ImportPayload } from "../importers/types.ts";

export async function prepareImport(file: File): Promise<ImportPayload> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const input = { name: file.name, bytes };
  const parser = await detectParser(input);
  if (!parser) throw new Error("지원하지 않는 파일이에요. 뱅크샐러드 내보내기 엑셀인지 확인해주세요.");
  const parsed = await parser.parse(input, {});
  const snapshot = (await parser.readSnapshot?.(input)) ?? null;
  // 간편결제로 낸 한 건이 네이버페이·카드 두 줄로 들어오는 것 — 여기서 표시해 둔다.
  // 서버는 500건씩 나눠 받아서 짝이 다른 조각으로 갈리면 못 찾는다 (importers/simple-pay.ts).
  const twins = simplePayTwins(parsed.transactions);
  for (const { pay } of twins) parsed.transactions[pay]!.excludeReason = SIMPLE_PAY_REASON;
  return {
    source: parser.id,
    fileName: file.name,
    fileSha256: await sha256Bytes(bytes),
    rows: await withDedupeKeys(parser.id, parsed.transactions),
    skipped: parsed.skipped,
    snapshot,
  };
}

export async function prepareCashReceipts(file: File) {
  return parseCashReceiptCsv(await file.text());
}
