import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { ledgerServer } from "./index.ts";

let db: SqliteDb;
let api: ReturnType<typeof ledgerServer.createApi>;

const KEY = "열쇠-테스트용-32자리-무작위값-aaaa";
type Bindings = { DB: SqliteDb; SETTINGS_KEY?: string; IMPORT_TOKEN?: string };
const env = (extra: Partial<Bindings> = {}): Bindings => ({ DB: db, SETTINGS_KEY: KEY, IMPORT_TOKEN: "가져오기키", ...extra });
const call = (path: string, init?: RequestInit, bindings: Bindings = env()) => api.request(path, init, bindings);
const put = (body: unknown, bindings: Bindings = env()) =>
  call("/mail-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, bindings);

const SETTINGS = { enabled: true, host: "imap.example.com", port: 993, user: "me", mailbox: "보관/가계부", sender: "export@example.com", everyMinutes: 10 };

beforeEach(() => {
  db = openMigratedSqlite();
  api = ledgerServer.createApi();
});

/** 저장된 원본 (화면으로는 안 나가는 값까지 본다) */
const stored = () => JSON.parse((db.raw.prepare("SELECT value FROM ledger_settings WHERE key = 'mail.config'").get() as { value: string }).value);

describe("메일 가져오기 설정", () => {
  it("설정을 저장하고 다시 읽는다 — 비밀값은 봉해서 넣고 화면에는 안 내보낸다", async () => {
    const res = await put({ ...SETTINGS, password: "메일비밀번호", zipPassword: "zip암호" });
    expect(res.status).toBe(200);
    const view = (await res.json()) as Record<string, unknown>;
    expect(view).toMatchObject({ host: "imap.example.com", user: "me", hasPassword: true, hasZipPassword: true, hasZipPassword2: false });
    // 비밀값 자체는 응답에 없어야 한다
    expect(JSON.stringify(view)).not.toContain("메일비밀번호");
    // DB 에도 평문으로 있으면 안 된다
    const raw = stored();
    expect(raw.password).toMatch(/^enc1:/);
    expect(JSON.stringify(raw)).not.toContain("메일비밀번호");
  });

  it("비밀값을 안 보내면 그대로 두고, 빈 값을 보내면 지운다", async () => {
    await put({ ...SETTINGS, password: "첫비번", zipPassword: "zip" });
    const before = stored().password;

    // 안 보냄 = 그대로
    await put({ ...SETTINGS, user: "바뀐계정" });
    expect(stored().password).toBe(before);
    expect(stored().user).toBe("바뀐계정");

    // 빈 값 = 지우기
    const res = await put({ ...SETTINGS, password: "" });
    expect(((await res.json()) as { hasPassword: boolean }).hasPassword).toBe(false);
  });

  it("열쇠(SETTINGS_KEY)가 없으면 비밀값을 평문으로 두지 않고 거절한다", async () => {
    const res = await put({ ...SETTINGS, password: "비번" }, { DB: db });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("SETTINGS_KEY");
    // 비밀값 없는 설정만이라면 열쇠가 없어도 저장된다
    const ok = await put(SETTINGS, { DB: db });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { canStoreSecrets: boolean }).canStoreSecrets).toBe(false);
  });

  it("연결 코드로 한 번만 받아 간다 — 쓰고 나면 사라지고, 두 번째는 막힌다", async () => {
    await put({ ...SETTINGS, password: "메일비번", zipPassword: "zip암호" });
    const { code } = (await (await call("/mail-config/link", { method: "POST" })).json()) as { code: string };
    expect(code).toHaveLength(24);

    const res = await call(`/mail-config/claim?code=${encodeURIComponent(code)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      host: "imap.example.com",
      user: "me",
      password: "메일비번",
      zipPassword: "zip암호",
      importToken: "가져오기키",
    });

    const again = await call(`/mail-config/claim?code=${encodeURIComponent(code)}`);
    expect(again.status).toBe(403);
  });

  it("모양이 맞는 틀린 코드는 막으면서 태운다 (찍어 보지 못하게)", async () => {
    const { code } = (await (await call("/mail-config/link", { method: "POST" })).json()) as { code: string };
    // 모양은 맞지만 값이 다른 코드 — 찍어 보는 것일 수 있으니 여기서 태운다
    expect((await call("/mail-config/claim?code=AAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(403);
    // 맞는 코드였어도 이미 태워졌다
    expect((await call(`/mail-config/claim?code=${encodeURIComponent(code)}`)).status).toBe(403);
  });

  it("모양조차 아닌 값은 DB 를 건드리지 않는다 — 남이 내 코드를 태우지 못하게", async () => {
    const { code } = (await (await call("/mail-config/link", { method: "POST" })).json()) as { code: string };
    for (const junk of ["", "아무거나", "../../etc", "a".repeat(200)]) {
      expect((await call(`/mail-config/claim?code=${encodeURIComponent(junk)}`)).status).toBe(403);
    }
    // 내 코드는 멀쩡히 살아 있다
    expect((await call(`/mail-config/claim?code=${encodeURIComponent(code)}`)).status).toBe(200);
  });

  it("열쇠가 바뀌면 예전 비밀값을 못 읽는다고 화면에 알려 준다", async () => {
    await put({ ...SETTINGS, password: "비번" });
    const res = await call("/mail-config", undefined, { DB: db, SETTINGS_KEY: "다른열쇠-aaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(await res.json()).toMatchObject({ hasPassword: true, secretsUnreadable: true });
  });

  it("이상한 값은 추려 낸다", async () => {
    const res = await put({ ...SETTINGS, port: 99999, everyMinutes: 1, host: "  imap.example.com  ", sender: "" });
    expect(await res.json()).toMatchObject({
      port: 993, // 범위 밖이면 기본값
      everyMinutes: 5, // 너무 자주면 올려 잡는다
      host: "imap.example.com",
      sender: "export-noreply@banksalad.com",
    });
  });
});
