import { banksaladParser } from "./banksalad.ts";
import type { ImportFile, ImportParser } from "./types.ts";

/** 등록된 파일 읽기 목록 (브라우저). 새 소스는 파일을 추가하고 여기와 rules.ts 에 넣는다. */
export const importParsers: ImportParser[] = [banksaladParser];

export async function detectParser(file: ImportFile): Promise<ImportParser | undefined> {
  for (const parser of importParsers) {
    if (await parser.detect(file)) return parser;
  }
  return undefined;
}
