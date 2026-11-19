import { describe, expect, it } from "vitest";
import { matchNotes, type NoteTx } from "./notes-import.ts";

const tx = (id: number, date: string, amount: number, merchant: string, memo: string | null = null, time = "12:00:00"): NoteTx => ({ id, date, time, amount, merchant, memo });

describe("matchNotes", () => {
  it("matches the same day and amount, preferring a similar shop name", () => {
    const txs = [tx(1, "2026-03-03", -23000, "가짜피자"), tx(2, "2026-03-03", -23000, "가짜치킨 역삼점")];
    const { matches } = matchNotes([{ date: "2026-03-03", amount: 23000, title: "가짜치킨", note: "양념 반" }], txs);
    expect(matches.map((m) => m.tx.id)).toEqual([2]);
  });

  it("falls back to a single match a day apart, and skips notes already there", () => {
    const txs = [tx(1, "2026-03-04", -8900, "가짜버거"), tx(2, "2026-03-05", -4500, "가짜카페", "아침\n이미 적음")];
    const r = matchNotes(
      [
        { date: "2026-03-03", amount: 8900, title: "가짜버거", note: "세트" },
        { date: "2026-03-05", amount: 4500, title: "가짜카페", note: "라떼" },
        { date: "2026-03-05", amount: 99000, title: "없음", note: "?" },
      ],
      txs,
    );
    expect(r.matches.map((m) => m.tx.id)).toEqual([1]);
    expect(r.already.length).toBe(1);
    expect(r.unmatched.length).toBe(1);
  });

  it("uses each transaction once", () => {
    const txs = [tx(1, "2026-03-03", -5000, "가짜분식")];
    const r = matchNotes(
      [
        { date: "2026-03-03", amount: 5000, title: "가짜분식", note: "떡볶이" },
        { date: "2026-03-03", amount: 5000, title: "가짜분식", note: "순대" },
      ],
      txs,
    );
    expect(r.matches.length).toBe(1);
    expect(r.unmatched.length).toBe(1);
  });
});

describe("POST /notes", () => {
  it("previews and applies notes, keeping the one-line memo", async () => {
    const { openMigratedSqlite } = await import("@homebase/db/sqlite");
    const { ledgerServer } = await import("./index.ts");
    const db = openMigratedSqlite();
    const api = ledgerServer.createApi();
    const insert = db.raw.prepare("INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, memo, source) VALUES ('expense', 'active', ?, '12:00:00', ?, ?, ?, 'manual')");
    insert.run("2026-03-03", "가짜치킨", -23000, "야식");
    insert.run("2026-03-04", "가짜버거", -8900, null);
    const body = { items: [{ date: "2026-03-03", amount: 23000, title: "가짜치킨", note: "양념 반\n후라이드 반" }, { date: "2026-03-04", amount: 8900, title: "가짜버거", note: "세트" }] };
    const call = async (path: string) =>
      (await (await api.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, { DB: db })).json()) as Record<string, unknown>;
    expect(await call("/notes/preview")).toMatchObject({ matched: 2, already: 0, unmatched: 0 });
    expect(await call("/notes/apply")).toEqual({ applied: 2 });
    const memos = (db.raw.prepare("SELECT memo FROM ledger_transactions ORDER BY date").all() as { memo: string }[]).map((r) => r.memo);
    expect(memos).toEqual(["야식\n양념 반\n후라이드 반", "\n세트"]);
    // 다시 하면 이미 있음
    expect(await call("/notes/preview")).toMatchObject({ matched: 0, already: 2 });
  });
});
