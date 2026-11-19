/**
 * 테스트용: 진짜 D1(로컬 workerd)을 띄워 마이그레이션까지 적용한다. better-sqlite3 어댑터와 달리
 * meta.rows_read 가 실제 D1 과 같게 나와서, 쿼리가 몇 행을 읽는지 잴 수 있다 (읽기 예산 테스트).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import type { SqlDb } from "./index.ts";
import { MIGRATIONS_DIR } from "./sqlite.ts";

const CONFIG = fileURLToPath(new URL("../test/d1.wrangler.jsonc", import.meta.url));

export async function openLocalD1(): Promise<{ db: SqlDb; dispose(): Promise<void> }> {
  const proxy = await getPlatformProxy<{ DB: SqlDb }>({ configPath: CONFIG, persist: false });
  const db = proxy.env.DB;
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8").replace(/^\s*--.*$/gm, "");
    const statements = sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  return { db, dispose: () => proxy.dispose() };
}
