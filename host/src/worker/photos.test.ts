import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { countReads } from "@homebase/db";
import { dropPhotos, type PhotoKV } from "@homebase/core/photos";
import { createApp } from "./app.ts";
import { counterAt, hotp } from "./totp.ts";

const ORIGIN = "https://homebase.test";
const PASSWORD = "가짜-비밀번호-for-tests";

/** KV 흉내 — Map */
class FakeKV implements PhotoKV {
  m = new Map<string, ArrayBuffer>();
  async put(k: string, v: ArrayBuffer) { this.m.set(k, v); }
  async get(k: string) { return this.m.get(k) ?? null; }
  async delete(k: string) { this.m.delete(k); }
}

let db: SqliteDb;
let kv: FakeKV | undefined;
let app: ReturnType<typeof createApp>;
let cookies: Record<string, string>;

async function send(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  if (init.method && init.method !== "GET") headers.set("Origin", ORIGIN);
  const res = await app.request(`${ORIGIN}${path}`, { ...init, headers }, { DB: countReads(db), LOGIN_PASSWORD: PASSWORD, PHOTOS: kv });
  for (const c of res.headers.getSetCookie()) {
    const [k, v] = c.split(";")[0]!.split("=");
    cookies[k!] = v!;
  }
  return res;
}
const form = (f: Record<string, string>) => new URLSearchParams(f);

beforeEach(async () => {
  db = openMigratedSqlite();
  kv = new FakeKV();
  app = createApp();
  cookies = {};
  // 로그인 (auth.test.ts 와 같은 길)
  const page = await (await send("/setup", { method: "POST", body: form({ password: PASSWORD }), headers: { "Content-Type": "application/x-www-form-urlencoded" } })).text();
  const secret = page.match(/<code>([A-Z2-7 ]+)<\/code>/)![1]!.replace(/ /g, "");
  await send("/setup/confirm", { method: "POST", body: form({ code: await hotp(secret, counterAt(Date.now())) }), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  db.raw.prepare("INSERT INTO calendar_events (id, title, start_date, end_date) VALUES (7, '가짜 일정', '2026-10-09', '2026-10-09')").run();
  db.raw.prepare("INSERT INTO ledger_transactions (id, kind, date, merchant, amount, source) VALUES (9, 'expense', '2026-10-09', '가짜가게', -1000, 'manual')").run();
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
function upload(app_: string, ref: string, bytes: Uint8Array<ArrayBuffer> = JPEG) {
  const f = new FormData();
  f.set("app", app_);
  f.set("ref", ref);
  f.set("full", new File([bytes], "full.jpg", { type: "image/jpeg" }));
  f.set("thumb", new File([bytes], "thumb.jpg", { type: "image/jpeg" }));
  f.set("w", "1600");
  f.set("h", "1200");
  return send("/api/photos", { method: "POST", body: f });
}

describe("사진 첨부", () => {
  it("올리고 · 목록 · 표시 · 파일(오래 캐시) · 지우기", async () => {
    const r = await upload("calendar", "7");
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    expect(kv!.m.has(`p/${id}`) && kv!.m.has(`p/${id}_t`)).toBe(true);
    const list = (await (await send("/api/photos?app=calendar&ref=7")).json()) as { photos: { id: string; width: number }[]; max: number };
    expect(list.photos.map((p) => p.id)).toEqual([id]);
    expect(list.photos[0]!.width).toBe(1600);
    expect(list.max).toBe(3);
    expect(await (await send("/api/photos/marks?app=calendar")).json()).toEqual({ marks: { "7": 1 } });
    const file = await send(`/api/photos/file/${id}?t=1`);
    expect(file.headers.get("Content-Type")).toBe("image/jpeg");
    expect(file.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(JPEG);
    expect((await send(`/api/photos/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(kv!.m.size).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM core_photos").get()).toEqual({ n: 0 });
  });

  it("항목당 3장까지 · JPEG 만 · 없는 항목은 거절", async () => {
    for (let i = 0; i < 3; i++) expect((await upload("ledger", "9")).status).toBe(200);
    expect((await upload("ledger", "9")).status).toBe(409);
    expect((await upload("ledger", "1", JPEG)).status).toBe(404);
    expect((await upload("calendar", "7", new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).status).toBe(415);
    expect((await upload("other", "7")).status).toBe(400);
  });

  it("로그인 없이는 사진 파일도 못 본다", async () => {
    const { id } = (await (await upload("calendar", "7")).json()) as { id: string };
    cookies = {};
    expect((await send(`/api/photos/file/${id}`)).status).not.toBe(200);
  });

  it("KV 가 없으면 올리기만 꺼진다 (503)", async () => {
    kv = undefined;
    expect((await upload("calendar", "7")).status).toBe(503);
    expect((await send("/api/photos?app=calendar&ref=7")).status).toBe(200);
  });

  it("일정을 지우면 붙은 사진도 지워진다", async () => {
    await upload("calendar", "7");
    expect((await send("/api/calendar/events/7", { method: "DELETE" })).status).toBe(200);
    expect(kv!.m.size).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM core_photos").get()).toEqual({ n: 0 });
  });

  it("옮기기 · 'lost:' 만 버리기", async () => {
    const { id } = (await (await upload("ledger", "9")).json()) as { id: string };
    db.raw.prepare("UPDATE core_photos SET ref = 'lost:notify.lost.x' WHERE id = ?").run(id);
    expect((await send("/api/photos/drop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: "ledger", ref: "9" }) })).status).toBe(400);
    expect((await send("/api/photos/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app: "ledger", from: "lost:notify.lost.x", to: 9 }) })).status).toBe(200);
    expect(db.raw.prepare("SELECT ref FROM core_photos").get()).toEqual({ ref: "9" });
  });

  it("사진 표가 아직 없어도(마이그레이션 전) 항목 삭제는 깨지지 않는다", async () => {
    db.raw.prepare("DROP TABLE core_photos").run();
    expect(await dropPhotos(db, kv, "calendar", [7])).toBe(0);
    expect((await send("/api/calendar/events/7", { method: "DELETE" })).status).toBe(200);
  });
});
