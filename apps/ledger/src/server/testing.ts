/** 서버 테스트 도우미: 가짜 뱅크샐러드 행을 브라우저와 같은 과정(읽기 → 중복 키 → 계획 → 저장)으로 넣는다 */
import type { SqlDb } from "@homebase/db";
import { banksaladParser } from "../importers/banksalad.ts";
import { withDedupeKeys } from "../importers/dedupe.ts";
import { importSources } from "../importers/rules.ts";
import { buildBanksaladXlsx, type FakeRow } from "../importers/testing/fake-banksalad.ts";
import { commitImport, planImport } from "./imports.ts";

export const BANKSALAD = { id: "banksalad-xlsx", ...importSources["banksalad-xlsx"]! };

export async function importFakeRows(db: SqlDb, rows: FakeRow[]) {
  const file = { name: "fake.xlsx", bytes: await buildBanksaladXlsx(rows) };
  const parsed = await banksaladParser.parse(file, {});
  const plan = await planImport(db, BANKSALAD, { rows: await withDedupeKeys(BANKSALAD.id, parsed.transactions), skipped: parsed.skipped });
  return { ...plan.summary, ...(await commitImport(db, plan, { name: file.name, sha256: "0".repeat(64) })) };
}
