import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { SqlDb } from "@homebase/db";
import { calendarServer } from "@homebase/calendar/server";
import { ledgerServer } from "@homebase/ledger/server";
import type { ServerModule } from "@homebase/core/server";
import { authRoutes, requireSession, sameOrigin } from "./auth.ts";
import { bumpRev, dataVersion, readRev } from "./revision.ts";
import { photoFileRoute, photoRoutes } from "./photos.ts";
import type { PhotoKV } from "@homebase/core/photos";

/** 새 앱을 추가하면 여기에 등록한다. (웹 쪽은 src/web/modules.ts) */
export const serverModules: ServerModule[] = [calendarServer, ledgerServer];

export interface Env {
  DB: SqlDb;
  LOGIN_PASSWORD?: string;
  /** 사진 바이트 (KV homebase-img, wrangler.jsonc). 없으면 사진 올리기·보기만 꺼진다 */
  PHOTOS?: PhotoKV;
  /** 빌드된 화면 파일 (Workers Assets). 테스트에서는 없음 */
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

export function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: { session?: { tokenHash: string; expiresAt: string }; skipRevBump?: boolean } }>();

  app.use(secureHeaders({ referrerPolicy: "same-origin", xFrameOptions: "DENY" }));
  app.use(async (c, next) => {
    await next();
    c.header("Cache-Control", c.res.headers.get("Cache-Control") ?? "no-store");
    c.header("X-Robots-Tag", "noindex, nofollow");
  });
  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));
  app.use(sameOrigin);
  app.route("/", authRoutes());
  app.use(requireSession);

  /**
   * 지금 데이터 버전. 화면이 **딱 한 번** 물어보고, 들고 있던 응답의 버전과 같으면
   * 나머지 조회는 네트워크를 아예 타지 않는다 (shared/core/src/web-cache.ts 참고).
   *
   * 아래 ETag 미들웨어보다 **먼저** 등록한다 — 여기서 응답이 끝나므로 꼬리표 계산을
   * 거치지 않는다. 읽는 건 1행뿐이라 왕복 한 번 값으로 나머지 다섯 번을 없앤다.
   */
  app.get("/api/rev", async (c) => c.json({ rev: dataVersion(await readRev(c.env.DB)) }));
  /** 사진 바이트 — 안 바뀌는 파일이라 데이터 버전과 상관없이 오래 캐시한다. 그래서 ETag 미들웨어보다 먼저 */
  app.route("/api/photos/file", photoFileRoute());

  /**
   * 바뀐 게 없으면 다시 만들지 않는다 (revision.ts 참고).
   *
   * 로그인 뒤에 둔다 — 인증 전에 304 를 돌려주면 남이 '데이터가 바뀌었는지' 를 떠볼 수 있다.
   * GET 만 본다. 꼬리표가 같으면 **핸들러를 돌리지 않고** 304 로 끝내므로, 달력 첫 진입의
   * 전체 훑기 셋(7만 행)을 통째로 건너뛴다.
   */
  app.use(async (c, next) => {
    if (c.req.method !== "GET" || !c.req.path.startsWith("/api/")) return next();
    const rev = dataVersion(await readRev(c.env.DB));
    // 경로+질의까지 꼬리표에 넣는다 — 같은 rev 라도 다른 달을 보면 응답이 다르다
    const tag = `W/"${rev}-${c.req.path}${new URL(c.req.url).search}"`;
    if (c.req.header("If-None-Match") === tag) return c.body(null, 304, { ETag: tag });
    await next();
    if (c.res.ok) {
      c.header("ETag", tag);
      // private = 이 사람 것만, no-cache = 쓰기 전에 꼭 물어봐라(캐시는 해도 된다)
      c.header("Cache-Control", "private, no-cache");
    }
  });

  /**
   * 뭔가 바뀐 요청이면 데이터 버전을 **한 번만** 올린다 (revision.ts 참고).
   *
   * 쓰기 경로 11곳을 하나도 손대지 않는 게 요점이다 — 손으로 올리게 하면 언젠가 빠뜨리고,
   * 빠뜨리면 그 변경이 화면에 **영영 반영되지 않는다**(느린 것보다 나쁜 고장). 대신 모든
   * 쿼리가 지나는 countReads 래퍼가 센 쓰기 수를 보고 여기서 한 번 올린다. 쿼리마다가
   * 아니라 요청당 한 번이라 2,244건 가져오기를 해도 조각 수만큼만 쓴다.
   */
  app.use(async (c, next) => {
    await next();
    // **GET 은 제외한다.** 읽기 요청에도 쓰기가 섞여 들어온다 — 세션 만료일 연장(하루 한 번),
    // 한 번만 도는 카테고리 이행 같은 살림이다. 그걸 데이터 변경으로 치면 꼬리표가 혼자
    // 바뀌어 캐시가 매번 깨진다(실제로 그래서 304 가 안 나왔다). 데이터가 바뀌는 길은
    // 언제나 POST/PUT/PATCH/DELETE 다.
    if (c.req.method === "GET" || c.req.method === "HEAD") return;
    // 핸들러가 "이건 살림이지 데이터 변경이 아니다" 라고 표시한 요청 (예: 10분마다 오는 자동 가져오기 생존 보고)
    if (c.get("skipRevBump")) return;
    const db = c.env.DB as { rowsWritten?: number };
    if (typeof db.rowsWritten === "number" && db.rowsWritten > 0) {
      await bumpRev(c.env.DB).catch((e) => console.warn(`버전 올리기 실패: ${e}`));
    }
  });

  app.get("/api/health", (c) => c.json({ ok: true, modules: serverModules.map((m) => m.id) }));
  /** 로그인 정보 (홈 화면용): 이 기기의 만료 시각과 로그인된 기기 수 */
  app.get("/api/session", async (c) => {
    const row = await c.env.DB.prepare("SELECT count(*) AS n FROM auth_sessions WHERE expires_at > ?")
      .bind(new Date().toISOString())
      .first<{ n: number }>();
    return c.json({ expiresAt: c.get("session")?.expiresAt ?? null, devices: row?.n ?? 0 });
  });
  for (const m of serverModules) app.route(`/api/${m.id}`, m.createApi());
  app.route("/api/photos", photoRoutes());
  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  // 화면 파일. 로그인한 뒤에만 준다 (wrangler.jsonc 의 run_worker_first)
  app.get("*", async (c) => {
    if (!c.env.ASSETS) return c.text("not found", 404);
    const res = await c.env.ASSETS.fetch(c.req.raw);
    // 해시가 붙은 파일은 오래 캐시해도 되지만 로그인한 사람 브라우저에만 남게 private
    const cache = new URL(c.req.url).pathname.startsWith("/assets/") ? "private, max-age=31536000, immutable" : "no-store";
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", cache);
    return out;
  });

  return app;
}
