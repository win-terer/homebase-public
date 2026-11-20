import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { countReads } from "@homebase/db";
import { createApp } from "./app.ts";
import { base32Encode, counterAt, hotp, verifyTotp } from "./totp.ts";
import { dataVersion } from "./revision.ts";

const ORIGIN = "https://homebase.test";
const PASSWORD = "가짜-비밀번호-for-tests";

let db: SqliteDb;
let app: ReturnType<typeof createApp>;
let cookies: Record<string, string>;

beforeEach(() => {
  db = openMigratedSqlite();
  app = createApp();
  cookies = {};
});

async function send(path: string, init: RequestInit & { form?: Record<string, string>; ip?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cookie", Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "));
  headers.set("CF-Connecting-IP", init.ip ?? "203.0.113.1");
  let body = init.body;
  if (init.form) {
    body = new URLSearchParams(init.form).toString();
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }
  if (init.method && init.method !== "GET") headers.set("Origin", headers.get("Origin") ?? ORIGIN);
  // 운영과 같은 길을 태운다 — countReads 가 쓰기를 세야 데이터 버전이 올라간다
  const res = await app.request(`${ORIGIN}${path}`, { ...init, headers, body }, { DB: countReads(db), LOGIN_PASSWORD: PASSWORD });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const [k, v] = pair!.split("=");
    if (/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(c)) delete cookies[k!];
    else cookies[k!] = v!;
  }
  return res;
}

const secretFromPage = (html: string) => html.match(/<code>([A-Z2-7 ]+)<\/code>/)![1]!.replace(/ /g, "");
const codeNow = (secret: string, offset = 0) => hotp(secret, counterAt(Date.now()) + offset);

async function setUp(): Promise<string> {
  const page = await (await send("/setup", { method: "POST", form: { password: PASSWORD } })).text();
  const secret = secretFromPage(page);
  const res = await send("/setup/confirm", { method: "POST", form: { code: await codeNow(secret) } });
  expect(res.status).toBe(302);
  return secret;
}

describe("totp", () => {
  it("matches the RFC 6238 test vector", async () => {
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    expect(await hotp(secret, counterAt(59_000))).toBe("287082");
    expect(await verifyTotp(secret, "287082", 59_000)).toBe(1);
    expect(await verifyTotp(secret, "287082", 59_000, 1)).toBeNull(); // 이미 쓴 코드
  });
});

describe("login", () => {
  it("serves only the icons without login", async () => {
    const env = { DB: db, LOGIN_PASSWORD: PASSWORD, ASSETS: { fetch: async () => new Response("icon") } };
    for (const icon of ["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png"]) {
      expect((await app.request(`${ORIGIN}${icon}`, {}, env)).status).toBe(200);
    }
    expect((await app.request(`${ORIGIN}/index.html`, {}, env)).status).toBe(302);
  });

  it("denies everything before login", async () => {
    expect((await send("/api/ledger/settings")).status).toBe(401);
    const page = await send("/ledger/stats");
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe("/login?next=%2Fledger%2Fstats");
    expect((await send("/login")).headers.get("Location")).toBe("/setup");
  });

  it("sets up OTP once with the password and then logs in", async () => {
    expect((await send("/setup", { method: "POST", form: { password: "wrong" } })).status).toBe(401);
    const secret = await setUp();
    expect((await send("/api/ledger/settings")).status).toBe(200);
    expect((await send("/setup")).headers.get("Location")).toBe("/login");

    await send("/logout", { method: "POST" });
    expect((await send("/api/ledger/settings")).status).toBe(401);

    const bad = await send("/login", { method: "POST", form: { password: PASSWORD, code: "000000", next: "/ledger" } });
    expect(bad.status).toBe(401);
    const ok = await send("/login", { method: "POST", form: { password: PASSWORD, code: await codeNow(secret, 1), next: "/ledger" } });
    expect(ok.headers.get("Location")).toBe("/ledger");
    expect((await send("/api/ledger/settings")).status).toBe(200);
  });

  it("rejects a reused code and an outside redirect", async () => {
    const secret = await setUp();
    cookies = {};
    const code = await codeNow(secret); // setUp 에서 이미 쓴 코드
    expect((await send("/login", { method: "POST", form: { password: PASSWORD, code } })).status).toBe(401);
    const ok = await send("/login", { method: "POST", form: { password: PASSWORD, code: await codeNow(secret, 1), next: "//evil.example" } });
    expect(ok.headers.get("Location")).toBe("/");
  });

  it("locks an IP after five wrong tries", async () => {
    const secret = await setUp();
    cookies = {};
    for (let i = 0; i < 5; i++) await send("/login", { method: "POST", form: { password: "x", code: "123456" } });
    const locked = await send("/login", { method: "POST", form: { password: PASSWORD, code: await codeNow(secret, 1) } });
    expect(locked.status).toBe(429);
    const other = await send("/login", { method: "POST", ip: "198.51.100.7", form: { password: PASSWORD, code: await codeNow(secret, 1) } });
    expect(other.status).toBe(302);
  });

  it("does not lock everyone when many IPs fail", async () => {
    const secret = await setUp();
    cookies = {};
    for (let i = 0; i < 40; i++) {
      await send("/login", { method: "POST", ip: `198.51.100.${i}`, form: { password: "x", code: "123456" } });
    }
    const mine = await send("/login", { method: "POST", ip: "203.0.113.99", form: { password: PASSWORD, code: await codeNow(secret, 1) } });
    expect(mine.status).toBe(302);
  });

  it("blocks cross-site writes and logs out everywhere", async () => {
    await setUp();
    const put = (origin: string) =>
      send("/api/ledger/settings", {
        method: "PUT",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ key: "k", value: "v" }),
      });
    expect((await put("https://evil.example")).status).toBe(403);
    expect((await put(ORIGIN)).status).toBe(200);
    await send("/logout-all", { method: "POST" });
    expect(db.raw.prepare("SELECT count(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });
  });
});

describe("sessions", () => {
  it("extends the session when used, at most once a day", async () => {
    await setUp();
    const expiry = () => (db.raw.prepare("SELECT expires_at AS e FROM auth_sessions").get() as { e: string }).e;
    const fresh = expiry();
    expect((await send("/api/ledger/settings")).status).toBe(200);
    expect(expiry()).toBe(fresh); // 방금 만든 세션은 그대로

    db.raw.prepare("UPDATE auth_sessions SET expires_at = ?").run(new Date(Date.now() + 3 * 86_400_000).toISOString());
    expect((await send("/api/session")).status).toBe(200);
    expect(Date.parse(expiry()) - Date.now()).toBeGreaterThan(29 * 86_400_000);

    db.raw.prepare("UPDATE auth_sessions SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect((await send("/api/session")).status).toBe(401);
  });
});

describe("theme boot script", () => {
  it("is the same in index.html and the login pages", async () => {
    const { THEME_BOOT } = await import("@homebase/ui/theme-boot");
    const fs = await import("node:fs");
    const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
    expect(html).toContain(`<script>${THEME_BOOT}</script>`);
    expect(await (await send("/setup")).text()).toContain(`<script>${THEME_BOOT}</script>`);
  });
});

describe("가져오기 전용 키", () => {
  // HTTP 헤더는 ASCII 만 담는다 — 실제 키도 base64url 난수라 ASCII 다
  const TOKEN = "fake-import-token-for-tests";
  const IMPORT = "/api/ledger/imports";

  /** 세션 없이, 키만 들고 보낸다 (스크립트가 하는 그대로) */
  const asScript = (path: string, token?: string, method = "POST") =>
    app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          ...(token ? { "X-Import-Token": token } : {}),
        },
        body: method === "POST" ? "{}" : undefined,
      },
      { DB: db, LOGIN_PASSWORD: PASSWORD, IMPORT_TOKEN: TOKEN },
    );

  it("키가 맞으면 로그인 없이 가져오기를 통과한다", async () => {
    const res = await asScript(IMPORT, TOKEN);
    expect(res.status).not.toBe(401); // 인증은 통과 — 본문이 빈 json 이라 그 뒤는 400 이어도 된다
  });

  it("키가 없거나 틀리면 막는다", async () => {
    expect((await asScript(IMPORT)).status).toBe(401);
    expect((await asScript(IMPORT, TOKEN + "x")).status).toBe(401);
  });

  it("가져오기 밖의 경로는 키로 열리지 않는다", async () => {
    for (const p of ["/api/ledger/transactions", "/api/session", "/api/ledger/settings"]) {
      expect((await asScript(p, TOKEN, "GET")).status, p).toBe(401);
    }
  });

  it("키가 설정돼 있지 않으면 아무것도 통과시키지 않는다", async () => {
    const res = await app.request(
      `${ORIGIN}${IMPORT}`,
      { method: "POST", headers: { Origin: ORIGIN, "X-Import-Token": TOKEN }, body: "{}" },
      { DB: db, LOGIN_PASSWORD: PASSWORD }, // IMPORT_TOKEN 없음
    );
    expect(res.status).toBe(401);
  });
});

describe("데이터 버전(ETag)", () => {
  /** 로그인한 뒤 GET 한 번 — 응답과 꼬리표를 돌려준다 */
  async function get(path: string, etag?: string) {
    return send(path, { headers: etag ? { "If-None-Match": etag } : {} });
  }

  beforeEach(async () => {
    await setUp();   // /setup → OTP 확인까지 끝내면 세션 쿠키가 생긴다
  });

  it("GET 에 꼬리표가 붙고, 같은 꼬리표로 다시 물으면 304 다", async () => {
    const first = await get("/api/health");
    const tag = first.headers.get("ETag");
    expect(tag).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toContain("no-cache");

    const again = await get("/api/health", tag!);
    expect(again.status).toBe(304);
  });

  it("읽기만 한 요청은 꼬리표를 바꾸지 않는다", async () => {
    const tag = (await get("/api/health")).headers.get("ETag")!;
    await send("/api/session");
    expect((await get("/api/health")).headers.get("ETag")).toBe(tag);
  });

  it("쓰기가 있었던 요청 뒤에는 꼬리표가 달라진다", async () => {
    const tag = (await get("/api/health")).headers.get("ETag")!;
    // 설정 저장 = 쓰기. 쓰기 경로를 손대지 않았는데도 래퍼가 알아서 버전을 올려야 한다
    const w = await send("/api/ledger/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "테스트키", value: "1" }),
    });
    expect(w.status).toBe(200);
    expect((await get("/api/health")).headers.get("ETag")).not.toBe(tag);
  });

  it("경로가 다르면 꼬리표도 다르다 (같은 버전이라도)", async () => {
    const a = (await get("/api/health")).headers.get("ETag");
    const b = (await get("/api/session")).headers.get("ETag");
    expect(a).not.toBe(b);
  });

  it("로그인 전에는 꼬리표를 주지 않는다 (바뀌었는지 떠볼 수 없게)", async () => {
    cookies = {};
    const res = await send("/api/health");
    expect(res.status).toBe(401);
    expect(res.headers.get("ETag")).toBeNull();
  });
});

describe("데이터 버전 — 살림 쓰기는 세지 않는다", () => {
  it("읽기 요청이 세션을 연장해도 꼬리표는 그대로다", async () => {
    await setUp();
    const tag = (await send("/api/health")).headers.get("ETag")!;
    // 세션을 오래된 것으로 만들어 다음 요청이 연장(=쓰기)하게 한다
    db.raw.prepare("UPDATE auth_sessions SET expires_at = ?").run(new Date(Date.now() + 3 * 86_400_000).toISOString());
    expect((await send("/api/session")).status).toBe(200);
    expect((await send("/api/health")).headers.get("ETag")).toBe(tag);
  });
});

describe("데이터 버전 — /api/rev", () => {
  beforeEach(async () => {
    await setUp();
  });

  it("화면이 한 번만 물어보는 버전을 돌려준다", async () => {
    const res = await send("/api/rev");
    expect(res.status).toBe(200);
    const { rev } = (await res.json()) as { rev: string };
    expect(rev).toMatch(/^\d+\.\d{4}-\d{2}-\d{2}$/);
  });

  it("꼬리표에 든 버전과 같은 값이다 (둘이 어긋나면 캐시가 안 맞는다)", async () => {
    const { rev } = (await (await send("/api/rev")).json()) as { rev: string };
    const tag = (await send("/api/health")).headers.get("ETag")!;
    expect(tag).toContain(rev);
  });

  it("쓰기 뒤에는 값이 달라진다", async () => {
    const before = (await (await send("/api/rev")).json()) as { rev: string };
    await send("/api/ledger/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "테스트키", value: "1" }),
    });
    const after = (await (await send("/api/rev")).json()) as { rev: string };
    expect(after.rev).not.toBe(before.rev);
  });

  it("로그인 전에는 주지 않는다", async () => {
    cookies = {};
    expect((await send("/api/rev")).status).toBe(401);
  });
});

describe("데이터 버전 — 날짜가 섞여 있다", () => {
  it("서울 기준 날이 바뀌면 버전도 바뀐다", () => {
    // 정기 결제의 '다음 예상일·안 나감' 은 오늘이 며칠이냐로 달라진다. 데이터가 그대로라
    // rev 는 안 오르므로, 날짜를 섞지 않으면 어제 답이 그대로 굳는다
    const lateNight = Date.parse("2026-10-02T14:00:00Z"); // 서울 23시
    const justAfter = Date.parse("2026-10-02T15:00:00Z"); // 서울 다음 날 0시
    expect(dataVersion("7", lateNight)).toBe("7.2026-10-02");
    expect(dataVersion("7", justAfter)).toBe("7.2026-10-03");
  });

  it("같은 날 안에서는 rev 가 그대로면 버전도 그대로다", () => {
    const morning = Date.parse("2026-10-02T01:00:00Z");
    const evening = Date.parse("2026-10-02T09:00:00Z");
    expect(dataVersion("7", morning)).toBe(dataVersion("7", evening));
  });
});

describe("폰 알림 받기 — 가져오기 키로 연다", () => {
  const NOTIFY = "/api/ledger/notify";
  const TOKEN = "notify-test-token";
  const env = { DB: undefined as never, LOGIN_PASSWORD: PASSWORD, IMPORT_TOKEN: TOKEN };

  const post = (body: unknown, token?: string) =>
    app.request(
      `${ORIGIN}${NOTIFY}`,
      {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", ...(token ? { "X-Import-Token": token } : {}) },
        body: JSON.stringify(body),
      },
      { ...env, DB: db },
    );

  it("키가 있으면 로그인 없이 받는다 (단축어는 OTP 를 칠 수 없다)", async () => {
    const res = await post({ app: "현대카드", title: "승인", body: "1,000원" }, TOKEN);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("키가 없으면 안 받는다", async () => {
    expect((await post({ app: "현대카드", body: "x" })).status).toBe(401);
  });

  it("키가 틀리면 안 받는다", async () => {
    // 키 값은 ASCII 로 — HTTP 헤더에 한글을 넣으면 보내기 전에 터진다
    expect((await post({ app: "현대카드", body: "x" }, "wrong-token")).status).toBe(401);
  });

  it("내용이 전부 비면 거절한다 (단축어 설정이 잘못된 것)", async () => {
    expect((await post({ app: "", title: "", body: "" }, TOKEN)).status).toBe(400);
  });

  it("받은 알림이 그대로 남는다 (해석은 나중에)", async () => {
    await post({ app: "토스", title: "제목", subtitle: "부제", body: "본문", sentAt: "2026-10-03 11:00" }, TOKEN);
    const row = db.raw.prepare("SELECT app, title, subtitle, body, sent_at, parsed_at FROM ledger_notifications ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
    expect(row).toMatchObject({ app: "토스", title: "제목", subtitle: "부제", body: "본문", sent_at: "2026-10-03 11:00" });
    expect(row.parsed_at).toBeNull();
  });
});

describe("알림 키와 가져오기 키는 다른 문을 연다", () => {
  const IMPORT = "import-test-token";
  const NOTIFY = "notify-only-token";
  const post = (path: string, token: string, body: unknown, env: Record<string, string | undefined>) =>
    app.request(
      `${ORIGIN}${path}`,
      { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Import-Token": token }, body: JSON.stringify(body) },
      { DB: db, LOGIN_PASSWORD: PASSWORD, ...env },
    );
  const both = { IMPORT_TOKEN: IMPORT, NOTIFY_TOKEN: NOTIFY };
  const alarm = { app: "현대카드", title: "승인", body: "1,000원" };

  it("알림 키는 /notify 만 연다", async () => {
    expect((await post("/api/ledger/notify", NOTIFY, alarm, both)).status).toBe(200);
    expect((await post("/api/ledger/sync-status", NOTIFY, { ok: true }, both)).status).toBe(401);
    expect((await post("/api/ledger/imports", NOTIFY, {}, both)).status).toBe(401);
    expect((await post("/api/ledger/imports/preview", NOTIFY, {}, both)).status).toBe(401);
  });

  it("알림 키가 있으면 가져오기 키로는 /notify 가 닫힌다 (폰이 새도 가져오기 키는 거기 없다)", async () => {
    expect((await post("/api/ledger/notify", IMPORT, alarm, both)).status).toBe(401);
    expect((await post("/api/ledger/sync-status", IMPORT, { ok: true }, both)).status).toBe(200);
  });

  it("알림 키가 아직 없으면 /notify 는 가져오기 키로 열린다 (Secret 넣기 전 과도기)", async () => {
    const only = { IMPORT_TOKEN: IMPORT };
    expect((await post("/api/ledger/notify", IMPORT, alarm, only)).status).toBe(200);
    expect((await post("/api/ledger/notify", NOTIFY, alarm, only)).status).toBe(401);
  });

  it("알림 키만 있고 가져오기 키가 없으면 가져오기 길은 닫혀 있다", async () => {
    const only = { NOTIFY_TOKEN: NOTIFY };
    expect((await post("/api/ledger/notify", NOTIFY, alarm, only)).status).toBe(200);
    expect((await post("/api/ledger/sync-status", NOTIFY, { ok: true }, only)).status).toBe(401);
    expect((await post("/api/ledger/imports", IMPORT, {}, only)).status).toBe(401);
  });
});

describe("폰 알림 → 임시 거래", () => {
  const TOKEN = "notify-test-token";
  const 승인 = "홍길동 님, 현대 ZERO 승인 \n12,000원 일시불, 10/3 11:09 \n가짜상점(주) \n누적1,000,000원";

  const notify = (body: string, app = "현대카드") =>
    app_request({ app, body });

  function app_request(payload: unknown) {
    return app.request(
      `${ORIGIN}/api/ledger/notify`,
      {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json", "X-Import-Token": TOKEN },
        body: JSON.stringify(payload),
      },
      { DB: db, LOGIN_PASSWORD: PASSWORD, IMPORT_TOKEN: TOKEN },
    );
  }

  const rows = () =>
    db.raw.prepare("SELECT date, time, merchant, amount, payment_method, source FROM ledger_transactions WHERE source = 'notify'").all() as Record<string, unknown>[];

  it("읽을 수 있으면 임시 거래가 생긴다", async () => {
    expect((await notify(승인)).status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ merchant: "가짜상점(주)", amount: -12000, payment_method: "현대 ZERO", source: "notify" });
  });

  it("같은 알림이 두 번 와도 거래는 하나다", async () => {
    await notify(승인);
    await notify(승인);
    expect(rows()).toHaveLength(1);
  });

  it("읽지 못한 알림은 원문만 남고 거래는 안 만든다 (광고가 훨씬 많다)", async () => {
    const res = await notify("이번 달 혜택을 확인해보세요");
    expect(res.status).toBe(200); // 실패로 치지 않는다 — 단축어가 쓸데없이 재시도한다
    expect(rows()).toHaveLength(0);
    const kept = db.raw.prepare("SELECT parsed_at FROM ledger_notifications ORDER BY id DESC LIMIT 1").get() as { parsed_at: string | null };
    expect(kept.parsed_at).toBeNull();
  });

  const category = () =>
    db.raw
      .prepare(
        "SELECT t.category_id AS id, t.category_source AS src, c.name FROM ledger_transactions t LEFT JOIN ledger_categories c ON c.id = t.category_id WHERE t.source = 'notify'",
      )
      .get() as { id: number | null; src: string | null; name: string | null };
  const 약국 = 승인.replace("가짜상점(주)", "가짜온누리약국");

  it("가맹점 이름 규칙으로 분류를 채운다 (약국 → 의료)", async () => {
    await notify(약국);
    expect(category()).toMatchObject({ name: "약국", src: "rule" });
  });

  it("모르는 가게는 미분류로 둔다", async () => {
    await notify(승인);
    expect(category()).toMatchObject({ id: null, src: null });
  });

  it("앱알림 줄에서 고른 분류는 같은 가맹점의 다음 알림에도 붙는다", async () => {
    const cat = db.raw.prepare("INSERT INTO ledger_categories (name) VALUES ('가짜분류') RETURNING id").get() as { id: number };
    db.raw.prepare("INSERT INTO ledger_settings (key, value) VALUES ('notify.category.가짜상점(주)', ?)").run(String(cat.id));
    await notify(승인);
    expect(category()).toMatchObject({ id: cat.id, src: "rule" });
  });

  it("가져오기 규칙(같은 가게·같은 금액)도 쓴다", async () => {
    const cat = db.raw.prepare("INSERT INTO ledger_categories (name) VALUES ('가짜분류') RETURNING id").get() as { id: number };
    db.raw.prepare("INSERT INTO ledger_settings (key, value) VALUES ('category.rule.-12000.가짜상점(주)', ?)").run(String(cat.id));
    await notify(승인);
    expect(category()).toMatchObject({ id: cat.id });
  });

  it("토스는 제목 금액 + 본문 카드|가맹점, 시각은 sentAt (본문에 시각이 없다)", async () => {
    const res = await app_request({ app: "토스", title: "2,900원 결제", body: "가짜카드 | 가짜커피_0(일시불)", sentAt: "2026년 10월 3일 오후 12시 42분 43초 GMT+9" });
    expect(res.status).toBe(200);
    expect(rows()[0]).toMatchObject({ date: "2026-10-03", time: "12:42:43", merchant: "가짜커피_0", amount: -2900, payment_method: "가짜카드", source: "notify" });
  });

  it("아직 모르는 앱은 원문만 남긴다", async () => {
    await notify("12,000원 승인, 10/3 11:09 \n가짜", "케이뱅크");
    expect(rows()).toHaveLength(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM ledger_notifications").get()).toMatchObject({ n: 1 });
  });
});

describe("자동 가져오기 생존 보고 — 가져오기 키로 연다", () => {
  const PATH = "/api/ledger/sync-status";
  const TOKEN = "sync-test-token";

  /** 운영과 같이 countReads 를 태운다 — 쓰기를 세야 "버전을 안 올렸다" 가 의미 있다 */
  const report = (body: unknown, token?: string) =>
    app.request(
      `${ORIGIN}${PATH}`,
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "),
          ...(token ? { "X-Import-Token": token } : {}),
        },
        body: JSON.stringify(body),
      },
      { DB: countReads(db), LOGIN_PASSWORD: PASSWORD, IMPORT_TOKEN: TOKEN },
    );

  it("키가 있으면 로그인 없이 받고, 없거나 틀리면 막는다", async () => {
    expect((await report({ ok: true }, TOKEN)).status).toBe(200);
    expect((await report({ ok: true })).status).toBe(401);
    expect((await report({ ok: true }, "wrong")).status).toBe(401);
  });

  it("ok 가 없으면 거절한다", async () => {
    expect((await report({ step: "fetch" }, TOKEN)).status).toBe(400);
  });

  it("실패가 쌓이고 성공하면 지워진다", async () => {
    await report({ ok: false, step: "fetch", error: "메일 서버 응답 없음" }, TOKEN);
    await report({ ok: false, step: "fetch", error: "메일 서버 응답 없음" }, TOKEN);
    const failed = (await (await report({ ok: false, step: "upload", error: "502" }, TOKEN)).json()) as { status: Record<string, unknown> };
    expect(failed.status).toMatchObject({ failStreak: 3, lastStep: "upload", lastError: "502", lastOkAt: null });
    const ok = (await (await report({ ok: true }, TOKEN)).json()) as { status: Record<string, unknown> };
    expect(ok.status).toMatchObject({ failStreak: 0, lastStep: null, lastError: null });
    expect(ok.status.lastOkAt).toBeTruthy();
    expect(ok.status.lastFailAt).toBeTruthy();
  });

  it("보고는 데이터 버전을 올리지 않는다 (10분마다 캐시가 깨지면 안 된다)", async () => {
    await setUp();
    const tag = (await send("/api/health")).headers.get("ETag")!;
    expect((await report({ ok: true }, TOKEN)).status).toBe(200);
    expect((await send("/api/health")).headers.get("ETag")).toBe(tag);
    // 그래도 보고 내용은 남아 있다 (알림 화면이 캐시 없이 읽는다)
    const o = (await (await send("/api/ledger/notify/overview")).json()) as { sync: { failStreak: number } | null };
    expect(o.sync).toMatchObject({ failStreak: 0 });
  });
});

describe("OTP 없이 쓰기", () => {
  /** QR 화면까지 간 뒤 '건너뛰기' 를 고른다 */
  async function skipOtp() {
    await send("/setup", { method: "POST", form: { password: PASSWORD } });
    return send("/setup/skip", { method: "POST" });
  }

  it("건너뛰면 그 자리에서 로그인되고, 다음부터 비밀번호만 묻는다", async () => {
    const res = await skipOtp();
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");

    // 로그인 화면에 OTP 칸이 없다
    const page = await (await send("/login")).text();
    expect(page).not.toContain('name="code"');
    expect(page).toContain("비밀번호를 넣어주세요");
  });

  it("비밀번호만으로 로그인된다", async () => {
    await skipOtp();
    cookies = {};
    const res = await send("/login", { method: "POST", form: { password: PASSWORD } });
    expect(res.status).toBe(302);
    expect((await send("/api/session")).status).toBe(200);
  });

  it("비밀번호가 틀리면 그대로 막힌다", async () => {
    await skipOtp();
    cookies = {};
    const res = await send("/login", { method: "POST", form: { password: "틀린값" } });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("비밀번호가 맞지 않아요");
  });

  it("setup 쿠키 없이 건너뛰기만 찔러서는 안 열린다", async () => {
    // 아직 아무것도 안 한 상태 — 설정부터 하라고 돌려보낸다
    expect((await send("/setup/skip", { method: "POST" })).headers.get("Location")).toBe("/login");
    expect((await send("/api/session")).status).toBe(401); // API 는 돌려보내지 않고 바로 막는다

    // 비밀번호 확인까지는 됐지만(행이 생겼다) **그 쿠키를 들고 있지 않은** 다른 사람
    await send("/setup", { method: "POST", form: { password: PASSWORD } });
    cookies = {};
    const res = await send("/setup/skip", { method: "POST" });
    expect(res.headers.get("Location")).toBe("/setup");
    // 세션은 끝내 안 생긴다
    expect((await send("/api/session")).status).toBe(401);
  });

  it("건너뛴 뒤에도 **나중에 켤 수 있다** — /setup 이 다시 열린다", async () => {
    await skipOtp();
    expect((await send("/setup")).status).toBe(200);
    const page = await (await send("/setup", { method: "POST", form: { password: PASSWORD } })).text();
    const secret = secretFromPage(page);
    expect((await send("/setup/confirm", { method: "POST", form: { code: await codeNow(secret) } })).status).toBe(302);

    // 이제 OTP 를 다시 묻고, /setup 은 닫힌다
    expect(await (await send("/login")).text()).toContain('name="code"');
    expect((await send("/setup")).headers.get("Location")).toBe("/login");
  });

  it("OTP 를 켜 둔 상태에서는 건너뛰기가 통하지 않는다", async () => {
    await setUp();
    const res = await send("/setup/skip", { method: "POST" });
    expect(res.headers.get("Location")).toBe("/login");
  });

  it("세션 조회가 OTP 를 쓰는지 알려 준다 (홈 화면이 켜라고 권할 때 쓴다)", async () => {
    await skipOtp();
    expect((await (await send("/api/session")).json())).toMatchObject({ otp: false });
    const page = await (await send("/setup", { method: "POST", form: { password: PASSWORD } })).text();
    await send("/setup/confirm", { method: "POST", form: { code: await codeNow(secretFromPage(page)) } });
    expect((await (await send("/api/session")).json())).toMatchObject({ otp: true });
  });
});
