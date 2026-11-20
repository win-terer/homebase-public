import { Hono } from "hono";
import type { SqlDb } from "@homebase/db";
import { dropPhotos, isPhotoApp, movePhotos, PHOTO_APPS, PHOTO_MAX, photoKey, savePhoto, type PhotoKV } from "@homebase/core/photos";

/**
 * 사진 첨부 API (/api/photos) — 일정·가계부 거래 공용. 저장 방식은 @homebase/core/photos 참고.
 *
 * - `GET  /file/:id[?t=1]`   사진(썸네일) 바이트. 사진은 한 번 올리면 안 바뀌므로 오래 캐시한다 — 그래서
 *                             app.ts 의 ETag 미들웨어보다 **먼저** 붙인다(`photoFileRoute`).
 * - `GET  /?app=&ref=`        그 항목의 사진 목록
 * - `GET  /marks?app=`        사진이 붙은 항목 id 목록 (줄마다 📷 표시용 — 혼자 쓰는 앱이라 사진 수가 작다)
 * - `POST /`                  올리기 (multipart: app, ref, full, thumb, w, h) — 항목당 3장
 * - `DELETE /:id`             지우기
 * - `POST /move`              다른 항목으로 옮기기 { app, from, to } (가계부 '옮기지 못한 메모' 붙이기)
 * - `POST /drop`              'lost:…' 로 남겨 둔 사진 버리기 { app, ref } ('옮기지 못한 메모' 지우기)
 */
type Env = { Bindings: { DB: SqlDb; PHOTOS?: PhotoKV } };

/** 사진 바이트 — ETag 미들웨어 앞에 붙인다 */
export function photoFileRoute() {
  const api = new Hono<Env>();
  api.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f]{32}$/.test(id)) return c.json({ error: "not_found" }, 404);
    if (!c.env.PHOTOS) return c.json({ error: "사진 기능이 아직 켜져 있지 않아요" }, 503);
    const buf = await c.env.PHOTOS.get(photoKey(id, c.req.query("t") === "1"), "arrayBuffer");
    if (!buf) return c.json({ error: "not_found" }, 404);
    // 로그인한 사람 브라우저에만, 1년 — id 가 무작위라 같은 주소의 내용이 바뀌는 일은 없다
    return c.body(buf, 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" });
  });
  return api;
}

export function photoRoutes() {
  const api = new Hono<Env>();

  api.get("/", async (c) => {
    const app = c.req.query("app"), ref = c.req.query("ref") ?? "";
    if (!isPhotoApp(app)) return c.json({ error: "알 수 없는 앱이에요" }, 400);
    const rows = await c.env.DB.prepare("SELECT id, width, height FROM core_photos WHERE app = ? AND ref = ? ORDER BY created_at, id")
      .bind(app, ref)
      .all<{ id: string; width: number | null; height: number | null }>()
      .catch(() => ({ results: [] }));
    return c.json({ photos: rows.results, max: PHOTO_MAX, enabled: Boolean(c.env.PHOTOS) });
  });

  api.get("/marks", async (c) => {
    const app = c.req.query("app");
    if (!isPhotoApp(app)) return c.json({ error: "알 수 없는 앱이에요" }, 400);
    const rows = await c.env.DB.prepare("SELECT ref, count(*) AS n FROM core_photos WHERE app = ? GROUP BY ref")
      .bind(app)
      .all<{ ref: string; n: number }>()
      .catch(() => ({ results: [] }));
    return c.json({ marks: Object.fromEntries(rows.results.map((r) => [r.ref, r.n])) });
  });

  api.post("/", async (c) => {
    if (!c.env.PHOTOS) return c.json({ error: "사진 기능이 아직 켜져 있지 않아요" }, 503);
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "올린 내용을 읽지 못했어요" }, 400);
    const app = form.get("app"), ref = String(form.get("ref") ?? "");
    const full = form.get("full"), thumb = form.get("thumb");
    if (!isPhotoApp(app) || !/^\d{1,15}$/.test(ref)) return c.json({ error: "어디에 붙일지 알 수 없어요" }, 400);
    if (!(full instanceof File) || !(thumb instanceof File)) return c.json({ error: "사진이 비어 있어요" }, 400);
    const [fb, tb] = await Promise.all([full.arrayBuffer(), thumb.arrayBuffer()]);
    const exists = await c.env.DB.prepare(`SELECT id FROM ${PHOTO_APPS[app]} WHERE id = ?`).bind(Number(ref)).first();
    if (!exists) return c.json({ error: "붙일 항목을 찾을 수 없어요 (지워졌을 수 있어요)" }, 404);
    const dim = (k: string) => {
      const n = Number(form.get(k));
      return Number.isInteger(n) && n > 0 && n <= 10000 ? n : null;
    };
    const saved = await savePhoto(c.env.DB, c.env.PHOTOS, app, ref, fb, tb, { w: dim("w"), h: dim("h") });
    if ("error" in saved) return c.json({ error: saved.error }, saved.status);
    return c.json({ id: saved.id });
  });

  api.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f]{32}$/.test(id)) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("DELETE FROM core_photos WHERE id = ?").bind(id).run();
    if (c.env.PHOTOS) await Promise.all([c.env.PHOTOS.delete(photoKey(id)), c.env.PHOTOS.delete(photoKey(id, true))]).catch(() => {});
    return c.json({ ok: true });
  });

  api.post("/move", async (c) => {
    const body = await c.req.json<{ app?: unknown; from?: unknown; to?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    const { app } = body;
    const from = String(body.from ?? ""), to = String(body.to ?? "");
    if (!isPhotoApp(app) || !from || !/^\d{1,15}$/.test(to)) return c.json({ error: "옮길 곳을 알 수 없어요" }, 400);
    const exists = await c.env.DB.prepare(`SELECT id FROM ${PHOTO_APPS[app]} WHERE id = ?`).bind(Number(to)).first();
    if (!exists) return c.json({ error: "붙일 항목을 찾을 수 없어요" }, 404);
    const have = await c.env.DB.prepare("SELECT count(*) AS n FROM core_photos WHERE app = ? AND ref IN (?, ?)").bind(app, from, to).first<{ n: number }>();
    if ((have?.n ?? 0) > PHOTO_MAX) return c.json({ error: `합치면 ${PHOTO_MAX}장이 넘어요 — 먼저 몇 장 지워 주세요` }, 409);
    return c.json({ moved: await movePhotos(c.env.DB, app, from, to) });
  });

  api.post("/drop", async (c) => {
    const body = await c.req.json<{ app?: unknown; ref?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    const ref = String(body.ref ?? "");
    // 항목에 붙은 사진은 항목을 지울 때만 같이 지운다 — 여기선 짝을 잃은 사진만
    if (!isPhotoApp(body.app) || !ref.startsWith("lost:")) return c.json({ error: "지울 수 없는 사진이에요" }, 400);
    return c.json({ dropped: await dropPhotos(c.env.DB, c.env.PHOTOS, body.app, [ref]) });
  });

  return api;
}
