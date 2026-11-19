/**
 * 로그인: 비밀번호(워커 Secret LOGIN_PASSWORD) + OTP 앱 코드.
 * - 처음 한 번 /setup 에서 비밀번호를 확인하고 OTP 비밀을 만든다. 등록이 끝나면 /setup 은 닫힌다.
 *   (폰을 잃어버리면 대시보드 D1 콘솔에서 `DELETE FROM auth_totp` 후 다시 등록)
 * - 틀린 시도는 IP당 10분에 5번까지만 받는다. 전체 잠금은 두지 않는다 — 남이 여러 IP 로 틀리기만 해도
 *   본인까지 못 들어가게 되므로. (비밀번호 + OTP 라 여러 IP 로 나눠 시도해도 뚫기 어렵다)
 * - 세션은 마지막으로 들어온 날부터 30일 (들어올 때마다 연장, DB 쓰기는 하루 한 번까지).
 *   쿠키에는 무작위 토큰, DB 에는 그 해시만 둔다.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { renderSVG } from "uqr";
import type { SqlDb } from "@homebase/db";
import { loginPage, messagePage, setupPasswordPage, setupQrPage } from "./pages.ts";
import { newSecret, otpauthUrl, verifyTotp } from "./totp.ts";

export interface AuthBindings {
  DB: SqlDb;
  LOGIN_PASSWORD?: string;
  /** 가져오기 전용 키 (워커 Secret). 없으면 그 경로는 평소대로 로그인만 받는다 */
  IMPORT_TOKEN?: string;
  /** 폰 알림 전용 키 (워커 Secret). 없으면 `/notify` 도 가져오기 키로 연다 (Secret 넣기 전 과도기) */
  NOTIFY_TOKEN?: string;
}
type AuthEnv = { Bindings: AuthBindings; Variables: { session?: { tokenHash: string; expiresAt: string } } };

export const SESSION_COOKIE = "__Host-hb_session";
const SETUP_COOKIE = "__Host-hb_setup";
const SESSION_DAYS = 30;
/** 남은 기간이 이보다 짧으면 연장한다 (매 요청마다 쓰지 않도록 하루 단위) */
const RENEW_BELOW_MS = (SESSION_DAYS - 1) * 86_400_000;
const IP_LIMIT = 5;
const IP_WINDOW_MS = 10 * 60_000;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** 비밀번호 비교 (길이·내용과 무관하게 같은 시간이 걸리도록 해시끼리 비교) */
async function passwordMatches(input: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const ipHash = (c: Context) => sha256(`${c.req.header("CF-Connecting-IP") ?? "local"}|homebase`);

/** 잠겼으면 안내 문구, 아니면 null */
async function lockedMessage(db: SqlDb, ip: string, now: number): Promise<string | null> {
  const row = await db
    .prepare("SELECT count(*) AS mine FROM auth_fails WHERE ip_hash = ? AND ts > ?")
    .bind(ip, now - IP_WINDOW_MS)
    .first<{ mine: number }>();
  if (row!.mine >= IP_LIMIT) return "틀린 시도가 많아요. 10분 뒤에 다시 해주세요.";
  return null;
}

async function recordFail(db: SqlDb, ip: string, now: number) {
  await db.batch([
    db.prepare("DELETE FROM auth_fails WHERE ts < ?").bind(now - IP_WINDOW_MS),
    db.prepare("INSERT INTO auth_fails (ip_hash, ts) VALUES (?, ?)").bind(ip, now),
  ]);
}

async function startSession(c: Context<AuthEnv>, extra: ReturnType<SqlDb["prepare"]>[] = []) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await c.env.DB.batch([
    ...extra,
    c.env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").bind(new Date().toISOString()),
    c.env.DB.prepare("INSERT INTO auth_sessions (token_hash, expires_at, user_agent) VALUES (?, ?, ?)").bind(
      await sha256(token),
      expires.toISOString(),
      (c.req.header("User-Agent") ?? "").slice(0, 200),
    ),
  ]);
  setCookie(c, SESSION_COOKIE, token, { path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires });
}

/** 로그인 뒤 돌아갈 곳. 같은 사이트 안의 경로만 받는다 */
const safeNext = (next: string | undefined) => (next && /^\/(?!\/)/.test(next) && !next.startsWith("/\\") ? next : "/");

const totpRow = (db: SqlDb) =>
  db.prepare("SELECT secret, confirmed, setup_token, last_counter FROM auth_totp WHERE id = 1").first<{
    secret: string;
    confirmed: number;
    setup_token: string | null;
    last_counter: number;
  }>();

export function authRoutes() {
  const auth = new Hono<AuthEnv>();

  auth.get("/login", async (c) => {
    const totp = await totpRow(c.env.DB);
    if (!totp?.confirmed) return c.redirect("/setup");
    return c.html(loginPage({ next: safeNext(c.req.query("next")) }));
  });

  auth.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const next = safeNext(typeof form.next === "string" ? form.next : undefined);
    const fail = (error: string, status: 401 | 429 = 401) => c.html(loginPage({ next, error }), status);
    const now = Date.now();
    const ip = await ipHash(c);
    const locked = await lockedMessage(c.env.DB, ip, now);
    if (locked) return fail(locked, 429);

    const totp = await totpRow(c.env.DB);
    if (!totp?.confirmed) return c.redirect("/setup");
    const password = typeof form.password === "string" ? form.password : "";
    const code = typeof form.code === "string" ? form.code.replace(/\s/g, "") : "";
    const okPassword = await passwordMatches(password, c.env.LOGIN_PASSWORD);
    const counter = await verifyTotp(totp.secret, code, now, totp.last_counter);
    if (!okPassword || counter === null) {
      await recordFail(c.env.DB, ip, now);
      return fail("비밀번호나 OTP 코드가 맞지 않아요.");
    }
    await startSession(c, [
      c.env.DB.prepare("UPDATE auth_totp SET last_counter = ? WHERE id = 1").bind(counter),
      c.env.DB.prepare("DELETE FROM auth_fails WHERE ip_hash = ?").bind(ip),
    ]);
    return c.redirect(next);
  });

  auth.get("/setup", async (c) => {
    const totp = await totpRow(c.env.DB);
    if (totp?.confirmed) return c.redirect("/login");
    if (!c.env.LOGIN_PASSWORD) return c.html(messagePage("설정 필요", "워커 설정에 LOGIN_PASSWORD 비밀이 없어요."), 503);
    return c.html(setupPasswordPage());
  });

  /** 비밀번호 확인 → OTP 비밀을 새로 만들고 QR 을 보여준다 (아직 등록 전) */
  auth.post("/setup", async (c) => {
    const now = Date.now();
    const ip = await ipHash(c);
    const totp = await totpRow(c.env.DB);
    if (totp?.confirmed) return c.redirect("/login");
    const locked = await lockedMessage(c.env.DB, ip, now);
    if (locked) return c.html(setupPasswordPage(locked), 429);
    const form = await c.req.parseBody();
    if (!(await passwordMatches(typeof form.password === "string" ? form.password : "", c.env.LOGIN_PASSWORD))) {
      await recordFail(c.env.DB, ip, now);
      return c.html(setupPasswordPage("비밀번호가 맞지 않아요."), 401);
    }
    const secret = newSecret();
    const token = randomToken();
    await c.env.DB.prepare(
      `INSERT INTO auth_totp (id, secret, confirmed, setup_token) VALUES (1, ?, 0, ?)
       ON CONFLICT (id) DO UPDATE SET secret = excluded.secret, setup_token = excluded.setup_token, confirmed = 0`,
    )
      .bind(secret, await sha256(token))
      .run();
    setCookie(c, SETUP_COOKIE, token, { path: "/", secure: true, httpOnly: true, sameSite: "Strict", maxAge: 15 * 60 });
    const qrSvg = renderSVG(otpauthUrl(secret, "me", "homebase"));
    return c.html(setupQrPage({ qrSvg, secret }));
  });

  /** QR 을 찍은 앱의 코드가 맞으면 등록을 끝내고 바로 로그인시킨다 */
  auth.post("/setup/confirm", async (c) => {
    const now = Date.now();
    const ip = await ipHash(c);
    const totp = await totpRow(c.env.DB);
    if (!totp || totp.confirmed) return c.redirect("/login");
    const token = getCookie(c, SETUP_COOKIE);
    if (!token || (await sha256(token)) !== totp.setup_token) return c.redirect("/setup");
    const locked = await lockedMessage(c.env.DB, ip, now);
    const form = await c.req.parseBody();
    const code = typeof form.code === "string" ? form.code.replace(/\s/g, "") : "";
    const counter = locked ? null : await verifyTotp(totp.secret, code, now);
    if (counter === null) {
      if (!locked) await recordFail(c.env.DB, ip, now);
      const qrSvg = renderSVG(otpauthUrl(totp.secret, "me", "homebase"));
      return c.html(setupQrPage({ qrSvg, secret: totp.secret, error: locked ?? "코드가 맞지 않아요. 앱에 나온 최신 코드를 넣어주세요." }), 401);
    }
    deleteCookie(c, SETUP_COOKIE, { path: "/", secure: true });
    await startSession(c, [
      c.env.DB.prepare("UPDATE auth_totp SET confirmed = 1, setup_token = NULL, last_counter = ? WHERE id = 1").bind(counter),
    ]);
    return c.redirect("/");
  });

  auth.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await c.env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.redirect("/login");
  });

  /** 모든 기기에서 로그아웃 (로그인된 상태에서만) */
  auth.post("/logout-all", async (c) => {
    if (!(await hasSession(c))) return c.redirect("/login");
    await c.env.DB.prepare("DELETE FROM auth_sessions").run();
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.redirect("/login");
  });

  return auth;
}

async function findSession(c: Context<AuthEnv>): Promise<{ tokenHash: string; expiresAt: string } | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await c.env.DB.prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, new Date().toISOString())
    .first<{ expires_at: string }>();
  if (!row) return null;

  // 들어올 때마다 30일로 연장 (하루에 한 번만 DB 에 쓴다)
  if (Date.parse(row.expires_at) - Date.now() < RENEW_BELOW_MS) {
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await c.env.DB.prepare("UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?").bind(expires.toISOString(), tokenHash).run();
    setCookie(c, SESSION_COOKIE, token, { path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires });
    return { tokenHash, expiresAt: expires.toISOString() };
  }
  return { tokenHash, expiresAt: row.expires_at };
}

const hasSession = async (c: Context<AuthEnv>) => (await findSession(c)) !== null;

/** 로그인 페이지·등록 페이지 말고는 전부 로그인이 필요하다 (기본 거부) */
// 아이콘은 로그인 화면·아이폰 홈 화면에서도 보여야 해서 로그인 없이 준다 (내용 없는 그림)
// 메일 설정을 받아 가는 자리는 **코드 자체가 열쇠**라 로그인 없이 연다 (코드는 10분·한 번, mail-config.ts).
// 가져오기 키로 열면 그 키가 새는 순간 메일 비밀번호까지 새기 때문에 이쪽으로 뺐다.
export const PUBLIC_PATHS = new Set([
  "/login",
  "/setup",
  "/setup/confirm",
  "/logout",
  "/favicon.svg",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/api/ledger/mail-config/claim",
]);

/**
 * 키로 들어올 수 있는 경로. **여기만** 열어 둔다. 세션이 없는 POST 에서만 보고, 헤더는 둘 다 `X-Import-Token`.
 *
 * - 가져오기 키(`IMPORT_TOKEN`): 집 맥북 스크립트. 메일로 온 뱅크샐러드 엑셀을 올리고(`/imports`,
 *   `/imports/preview`), 살아 있다고 보고한다(`/sync-status`). 이 스크립트는 OTP 를 칠 수 없어 세션을
 *   못 만든다. 그렇다고 전체 API 를 열면 키 하나가 새는 순간 가계부 전체가 열리므로 경로를 못 박는다.
 * - 알림 키(`NOTIFY_TOKEN`): 아이폰 단축어. `/notify` 하나만 연다.
 *
 * 키를 둘로 나눈 이유 — 폰 쪽이 더 잘 샌다(단축어 앱에서 값이 그대로 보이고 iCloud 로 복제된다).
 * 알림 키로는 임시 거래를 끼워 넣는 것까지만 되고 그마저 엑셀이 덮으면 사라진다. 가져오기 키가
 * 새면 1년치 거래를 통째로 바꿔치기할 수 있다. 더 잘 새는 쪽에 더 작은 열쇠를 쥐여 준다.
 *
 * `NOTIFY_TOKEN` 이 아직 없으면 `/notify` 는 가져오기 키로도 열린다 — 배포하고 Secret 을 넣기까지
 * 폰이 끊기지 않게. 넣는 순간 가져오기 키로는 `/notify` 가 닫힌다.
 * 키가 하나도 설정돼 있지 않으면 아무것도 통과시키지 않는다 — 닫힘이 기본이다.
 */
const IMPORT_PATHS = new Set(["/api/ledger/imports", "/api/ledger/imports/preview", "/api/ledger/sync-status"]);
const NOTIFY_PATHS = new Set(["/api/ledger/notify"]);

/** 이 경로에 맞는 키. 둘 다 아니면 undefined (= 키로는 못 들어온다) */
function expectedToken(c: Context<AuthEnv>): string | undefined {
  const path = c.req.path;
  if (IMPORT_PATHS.has(path)) return c.env.IMPORT_TOKEN;
  if (NOTIFY_PATHS.has(path)) return c.env.NOTIFY_TOKEN || c.env.IMPORT_TOKEN;
  return undefined;
}

/** 이 경로의 키가 맞는지. 비교는 길이가 새지 않게 해시 뒤 상수 시간으로 (비밀번호와 같은 방식) */
async function importTokenOk(c: Context<AuthEnv>): Promise<boolean> {
  if (c.req.method !== "POST") return false;
  const expected = expectedToken(c);
  if (!expected) return false;
  const given = c.req.header("X-Import-Token");
  if (!given) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const requireSession: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) return next();
  const session = await findSession(c);
  if (session) {
    c.set("session", session);
    return next();
  }
  // 세션이 없을 때만 본다 — 로그인한 사람의 흐름은 건드리지 않는다
  if (await importTokenOk(c)) return next();
  if (c.req.path.startsWith("/api/")) return c.json({ error: "로그인이 필요해요" }, 401);
  if (c.req.method !== "GET") return c.text("로그인이 필요해요", 401);
  const url = new URL(c.req.url);
  return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
};

/**
 * 다른 사이트에서 보낸 요청 막기: GET 이 아닌 요청은 Origin 이 이 사이트여야 한다.
 * (쿠키가 SameSite=Lax 라 이미 막히지만 한 겹 더)
 */
export const sameOrigin: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const origin = c.req.header("Origin");
  if (origin !== new URL(c.req.url).origin) return c.text("허용되지 않은 요청이에요", 403);
  return next();
};
