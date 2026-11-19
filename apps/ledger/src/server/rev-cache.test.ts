import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { revCached } from "./rev-cache.ts";

let db: SqliteDb;
beforeEach(() => { db = openMigratedSqlite(); });

const setRev = (v: string) =>
  db.raw.prepare("INSERT INTO app_meta (key, value) VALUES ('data.rev', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(v);

describe("rev-cache", () => {
  it("두 번째부터는 다시 계산하지 않는다", async () => {
    let ran = 0;
    const calc = async () => { ran++; return { n: 42 }; };
    expect(await revCached(db, "t", calc)).toEqual({ n: 42 });
    expect(await revCached(db, "t", calc)).toEqual({ n: 42 });
    expect(ran).toBe(1);
  });

  it("데이터 버전이 바뀌면 다시 계산한다", async () => {
    let ran = 0;
    const calc = async () => { ran++; return ran; };
    await revCached(db, "t", calc);
    setRev("5");
    expect(await revCached(db, "t", calc)).toBe(2);
    expect(ran).toBe(2);
  });

  it("이름이 다르면 서로 간섭하지 않는다", async () => {
    expect(await revCached(db, "a", async () => "A")).toBe("A");
    expect(await revCached(db, "b", async () => "B")).toBe("B");
    expect(await revCached(db, "a", async () => "달라짐")).toBe("A");
  });

  it("저장해 둔 값이 깨져 있으면 다시 계산한다", async () => {
    await revCached(db, "t", async () => 1);
    db.raw.prepare("UPDATE app_meta SET value = '깨진 json' WHERE key = 'cache.t'").run();
    expect(await revCached(db, "t", async () => 2)).toBe(2);
  });
});
