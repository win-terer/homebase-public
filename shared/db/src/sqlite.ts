/**
 * 테스트·로컬 도구용: better-sqlite3 를 D1 과 같은 모양(SqlDb)으로 감싼다. 워커 번들에는 들어가지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { RunResult, SqlDb, SqlStatement, SqlValue } from "./index.ts";

/** 저장소의 D1 마이그레이션 폴더 (wrangler.jsonc 의 migrations_dir 와 같은 곳) */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

export interface SqliteDb extends SqlDb {
  /** 테스트에서 직접 확인할 때 쓰는 원래 연결 */
  raw: Database.Database;
}

export function openSqlite(file = ":memory:"): SqliteDb {
  const raw = new Database(file);
  raw.pragma("foreign_keys = ON");

  const statement = (sql: string, values: SqlValue[] = []): SqlStatement & { exec(): RunResult } => {
    const exec = (): RunResult => {
      const r = raw.prepare(sql).run(...values);
      return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    };
    return {
      bind: (...next) => statement(sql, next),
      first: async <T>() => ((raw.prepare(sql).get(...values) as T | undefined) ?? null),
      all: async <T>() => ({ results: raw.prepare(sql).all(...values) as T[] }),
      run: async () => exec(),
      exec,
    };
  };

  return {
    raw,
    prepare: (sql) => statement(sql),
    batch: async (statements) =>
      raw.transaction(() => statements.map((s) => (s as ReturnType<typeof statement>).exec()))(),
  };
}

/** 마이그레이션 폴더의 *.sql 을 이름순으로 모두 적용한 새 DB (테스트용) */
export function openMigratedSqlite(file = ":memory:"): SqliteDb {
  const db = openSqlite(file);
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    db.raw.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
  }
  return db;
}
