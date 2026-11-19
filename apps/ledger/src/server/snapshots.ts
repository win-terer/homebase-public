import type { SqlDb } from "@homebase/db";
import type { Snapshot } from "../importers/banksalad-snapshot.ts";

/** 기준일별 재무 스냅샷 저장 (같은 기준일이면 덮어씀) */
export async function saveSnapshot(db: SqlDb, asOf: string, s: Snapshot) {
  const { creditScore, ...data } = s;
  await db.prepare(
    `INSERT INTO ledger_snapshots (as_of, credit_score, data) VALUES (?, ?, ?)
     ON CONFLICT (as_of) DO UPDATE SET credit_score = excluded.credit_score, data = excluded.data,
       imported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(asOf, creditScore, JSON.stringify(data))
    .run();
}

export async function latestSnapshot(db: SqlDb): Promise<(Snapshot & { asOf: string }) | null> {
  const row = await db
    .prepare("SELECT as_of, credit_score, data FROM ledger_snapshots ORDER BY as_of DESC LIMIT 1")
    .first<{ as_of: string; credit_score: number | null; data: string }>();
  if (!row) return null;
  return { asOf: row.as_of, creditScore: row.credit_score, ...(JSON.parse(row.data) as Omit<Snapshot, "creditScore">) };
}
