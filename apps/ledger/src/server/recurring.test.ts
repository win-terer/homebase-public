import { describe, expect, it } from "vitest";
import { detectRecurring, type RecurringInput } from "./recurring.ts";

let id = 0;
const row = (key: string, date: string, amount: number, kind: "expense" | "transfer" = "expense"): RecurringInput => ({
  id: ++id, key, name: key, kind, review: false, date, amount, category: null,
});

describe("detectRecurring", () => {
  it("finds a monthly payment that moves a few days around holidays", () => {
    const rows = ["2026-05-25", "2026-06-25", "2026-07-27", "2026-08-25", "2026-09-25"].map((d) => row("가짜보험", d, 60000, "transfer"));
    const [r] = detectRecurring(rows, "2026-10-01");
    expect(r).toMatchObject({ key: "가짜보험", period: "month", anchor: "25", nextDate: "2026-10-25", missed: false, monthly: 60000, kind: "transfer", count: 5 });
  });

  it("uses the month end for end-of-month payments and flags a changed amount", () => {
    const rows = [
      row("가짜구독", "2026-06-30", 4990),
      row("가짜구독", "2026-07-31", 4990),
      row("가짜구독", "2026-08-31", 4990),
      row("가짜구독", "2026-09-30", 7890),
    ];
    const [r] = detectRecurring(rows, "2026-10-01");
    expect(r).toMatchObject({ anchor: "31", nextDate: "2026-10-31", changedFrom: 4990, lastAmount: 7890 });
  });

  it("ignores a favourite shop with varying amounts and irregular visits", () => {
    const rows = [row("가짜식당", "2026-07-02", 9000), row("가짜식당", "2026-07-30", 31000), row("가짜식당", "2026-09-01", 12000), row("가짜식당", "2026-09-29", 55000)];
    expect(detectRecurring(rows, "2026-10-01")).toEqual([]);
  });

  it("flags a missed payment and drops long-stopped ones", () => {
    const rows = ["2026-06-01", "2026-07-01", "2026-08-01"].map((d) => row("가짜헬스", d, 50000));
    expect(detectRecurring(rows, "2026-09-12")[0]).toMatchObject({ missed: true, nextDate: "2026-09-01" });
    expect(detectRecurring(rows, "2026-11-30")).toEqual([]);
  });

  it("finds weekly and yearly payments", () => {
    const weekly = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"].map((d) => row("가짜주간", d, 3000));
    const yearly = ["2024-03-10", "2025-03-11", "2026-03-10"].map((d) => row("가짜연회비", d, 120000));
    const found = detectRecurring([...weekly, ...yearly], "2026-10-01");
    expect(found.find((r) => r.key === "가짜주간")).toMatchObject({ period: "week", nextDate: "2026-10-06", monthly: 13000 });
    expect(found.find((r) => r.key === "가짜연회비")).toMatchObject({ period: "year", nextDate: "2027-03-10", monthly: 10000 });
  });

  it("accepts varying amounts only for regular fixed costs", () => {
    const bills = [90000, 162000, 131000, 210000, 170000];
    const dates = ["2026-05-25", "2026-06-25", "2026-07-24", "2026-08-25", "2026-09-25"];
    const mgmt = dates.map((d, i) => ({ ...row("가짜아파트관리비", d, bills[i]!), group: "주거" }));
    const [r] = detectRecurring(mgmt, "2026-10-01", { memos: new Map([["가짜아파트관리비", "자동이체"]]) });
    expect(r).toMatchObject({ variable: true, expected: 170333, range: [131000, 210000], changedFrom: null, memo: "자동이체", monthly: 170333 });
    // 같은 모양이라도 고정비가 아니면 안 잡는다 (단골 가게)
    const shop = dates.map((d, i) => ({ ...row("가짜단골", d, bills[i]! / 10), group: "식비" }));
    expect(detectRecurring(shop, "2026-10-01")).toEqual([]);
  });

  it("finds every-two-months bills and incoming salary", () => {
    const water = ["2026-03-31", "2026-05-29", "2026-07-31", "2026-09-30"].map((d, i) => ({ ...row("가짜수도", d, [30000, 26000, 41000, 33000][i]!), group: "주거" }));
    const pay = ["2026-06-25", "2026-07-24", "2026-08-25", "2026-09-25"].map((d) => ({ ...row("+가짜회사", d, 1000000, "transfer"), direction: "in" as const }));
    const found = detectRecurring([...water, ...pay], "2026-10-01");
    expect(found.find((r) => r.key === "가짜수도")).toMatchObject({ period: "bimonth", anchor: "31", nextDate: "2026-11-30", direction: "out" });
    expect(found.find((r) => r.key === "+가짜회사")).toMatchObject({ period: "month", direction: "in", nextDate: "2026-10-25" });
  });

  it("accepts a utility paid on irregular dates (gas bill)", () => {
    const pays: [string, number][] = [["2026-03-25", 1500], ["2026-04-26", 24000], ["2026-06-05", 20000], ["2026-08-01", 21000], ["2026-08-29", 5000]];
    const rows = pays.map(([d, a]) => ({ ...row("가짜에너지", d, a), category: "주거 › 가스비", group: "주거" }));
    const [r] = detectRecurring(rows, "2026-10-01");
    expect(r).toMatchObject({ key: "가짜에너지", irregular: true, variable: true, gap: 36, nextDate: "2026-10-04", missed: false });
    // 고정비가 아닌 단골 가게는 그대로 안 잡는다
    expect(detectRecurring(pays.map(([d, a]) => row("가짜식당", d, a)), "2026-10-01")).toEqual([]);
  });

  it("shifts to business days only when nothing was ever paid on a day off", () => {
    // 전부 평일에 나간 자동이체 → 쉬는 날이면 뒤로
    const weekdays = ["2026-06-10", "2026-07-10", "2026-08-10", "2026-09-10"].map((d) => row("가짜자동이체", d, 5000, "transfer"));
    expect(detectRecurring(weekdays, "2026-10-01")[0]).toMatchObject({ shift: "after" });
    // 토요일에도 나간 카드 결제 → 그대로
    const card = ["2026-06-21", "2026-07-21", "2026-08-21", "2026-09-21"].map((d) => row("가짜카드구독", d, 5000));
    expect(detectRecurring(card, "2026-10-01")[0]).toMatchObject({ shift: null });
  });

  it("respects ignore and manual include", () => {
    const rows = ["2026-07-10", "2026-08-10", "2026-09-10"].map((d) => row("가짜", d, 1000));
    expect(detectRecurring(rows, "2026-10-01", { ignore: new Set(["가짜"]) })).toEqual([]);
    const two = ["2026-08-05", "2026-09-05"].map((d) => row("두번", d, 9900));
    expect(detectRecurring(two, "2026-10-01")).toEqual([]);
    expect(detectRecurring(two, "2026-10-01", { include: new Set(["두번"]) })[0]).toMatchObject({ manual: true, nextDate: "2026-10-05" });
  });
});

describe("GET /recurring", () => {
  it("detects from the DB, includes transfers and honours 정기 아님", async () => {
    const { openMigratedSqlite } = await import("@homebase/db/sqlite");
    const { ledgerServer, forgetRecurring } = await import("./index.ts");
    const db = openMigratedSqlite();
    const api = ledgerServer.createApi();
    forgetRecurring();
    const insert = db.raw.prepare("INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, source) VALUES (?, ?, ?, '09:00:00', ?, ?, 'manual')");
    const today = new Date(Date.now() + 9 * 3_600_000);
    for (let back = 4; back >= 1; back--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 10)).toISOString().slice(0, 10);
      insert.run("transfer", "active", d, `가짜생명0${back}000`, -60000);
      insert.run("expense", "active", d, "가짜구독", -9900);
      insert.run("income", "active", d, "가짜이자", 12); // 몇십 원 이자는 정기로 안 봄
    }
    const get = async () => (await (await api.request("/recurring", undefined, { DB: db })).json()) as { items: { key: string; kind: string }[]; ignored: { key: string }[] };
    expect((await get()).items.map((i) => [i.key, i.kind]).sort()).toEqual([["가짜구독", "expense"], ["가짜생명", "transfer"]]);
    db.raw.prepare("INSERT INTO ledger_settings (key, value) VALUES ('recurring.ignore.가짜구독', '1')").run();
    const after = await get();
    expect(after.items.map((i) => i.key)).toEqual(["가짜생명"]);
    expect(after.ignored.map((i) => i.key)).toEqual(["가짜구독"]);
    // 이름이 바뀐 같은 정기 결제를 합친다: 마지막 달에 다른 이름으로 나간 경우
    const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).toISOString().slice(0, 10);
    insert.run("transfer", "active", last, "가짜새이름", -60000);
    db.raw.prepare("INSERT INTO ledger_settings (key, value) VALUES ('recurring.alias.가짜새이름', '가짜생명')").run();
    forgetRecurring();
    const merged = (await (await api.request("/recurring", undefined, { DB: db })).json()) as { items: { key: string; count: number; aliases: string[] }[]; names: string[] };
    expect(merged.items.find((i) => i.key === "가짜생명")).toMatchObject({ count: 5, aliases: ["가짜새이름"] });
    // 최근에 새 이름으로 나갔어도 제목은 원래 이름, 지난 내역에는 줄마다 이름
    const life = (merged.items as unknown as { key: string; name: string; history: { name: string }[] }[]).find((i) => i.key === "가짜생명")!;
    expect(life.name).toMatch(/^가짜생명/);
    expect(life.history[0]!.name).toBe("가짜새이름");
    expect(merged.names).toContain("가짜새이름");
  });

  it("moves memos and merges saved under the old raw-name key", async () => {
    const { openMigratedSqlite } = await import("@homebase/db/sqlite");
    const { ledgerServer, forgetRecurring, forgetDisplayNames } = await import("./index.ts");
    const db = openMigratedSqlite();
    forgetRecurring();
    forgetDisplayNames();
    const insert = db.raw.prepare("INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, source) VALUES ('expense', 'active', ?, '09:00:00', '(주)가짜회사', -9900, 'manual')");
    const today = new Date(Date.now() + 9 * 3_600_000);
    for (let back = 4; back >= 1; back--) insert.run(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 12)).toISOString().slice(0, 10));
    // 마지막 달은 다른 이름으로 나갔고 예전 키로 합쳐 둠
    db.raw.prepare("INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, source) VALUES ('transfer', 'active', ?, '09:00:00', '가짜새계좌', -9900, 'manual')").run(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).toISOString().slice(0, 10));
    db.raw.prepare("INSERT INTO ledger_settings (key, value) VALUES ('recurring.memo.(주)가짜회사', '가짜 메모'), ('recurring.alias.가짜새계좌', '(주)가짜회사')").run();
    const res = (await (await ledgerServer.createApi().request("/recurring", undefined, { DB: db })).json()) as { items: { key: string; memo: string | null; count: number; aliases: string[] }[] };
    expect(res.items).toMatchObject([{ key: "가짜회사", memo: "가짜 메모", count: 5, aliases: ["가짜새계좌"] }]);
    const saved = db.raw.prepare("SELECT key, value FROM ledger_settings WHERE key LIKE 'recurring.%' ORDER BY key").all();
    expect(saved).toEqual([
      { key: "recurring.alias.가짜새계좌", value: "가짜회사" },
      { key: "recurring.memo.가짜회사", value: "가짜 메모" },
    ]);
  });

  it("groups names that differ only by spacing or underscores", async () => {
    const { openMigratedSqlite } = await import("@homebase/db/sqlite");
    const { ledgerServer, forgetRecurring, forgetDisplayNames } = await import("./index.ts");
    const db = openMigratedSqlite();
    forgetRecurring();
    forgetDisplayNames();
    const insert = db.raw.prepare("INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, source) VALUES ('expense', 'active', ?, '09:00:00', ?, -7890, 'manual')");
    const today = new Date(Date.now() + 9 * 3_600_000);
    const spellings = ["가짜_멤버십", "가짜 멤버십", "가짜_멤버십", "가짜멤버십"];
    spellings.forEach((name, i) => insert.run(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 4 + i, 21)).toISOString().slice(0, 10), name));
    const res = (await (await ledgerServer.createApi().request("/recurring", undefined, { DB: db })).json()) as { items: { key: string; count: number }[] };
    expect(res.items).toMatchObject([{ key: "가짜_멤버십", count: 4 }]);
  });
});
