/**
 * 동거인(손님)에게 열리는 **전부**. 이 파일 밖은 손님에게 401 이다 (host `auth.ts` 의 `requireSession`).
 *
 * ## 왜 기존 일정 API 에 '손님이면 거르기' 를 끼워 넣지 않았나
 *
 * 그러면 `/api/calendar` 에 라우트를 하나 더 붙일 때마다 거르기를 같이 적어야 하고, **한 번 빠뜨리면
 * 일정 전체가 샌다.** 집 맥북 스크립트에 쥐여 준 가져오기 키를 경로 세 개로 못 박아 둔 것과 같은 이유다.
 * 그래서 손님은 처음부터 좁게 판 이 길로만 다니고, 여기 핸들러는 **전부 공유 카테고리를 쿼리에 박는다** —
 * 읽어 와서 JS 에서 거르는 게 아니라 WHERE 에 넣는다.
 *
 * ## 무엇이 열리나
 *
 * 일정 한 카테고리(`app_meta` 의 `calendar.guest_category`)의 보기·쓰기·고치기·지우기와 그 일정에
 * 붙는 사진. 카테고리가 정해져 있지 않거나 지워졌으면 **전부 403** — 닫힘이 기본이다.
 */
import { Hono } from "hono";
import type { AppBindings, AppEnv } from "@homebase/core/server";
import { json, ReadBudgetError, type SqlDb } from "@homebase/db";
import { dropPhotos, PHOTO_MAX, photoKey, savePhoto } from "@homebase/core/photos";
import { touchPresence } from "@homebase/core/presence";
import { addDays, daysBetween, expandEvents, MAX_SPAN_DAYS, type CalendarEvent } from "../shared/occurrences.ts";
import { BadRequest, DATE, EVENT_COLUMNS, type EventRow, insertEvent, parseEvent, photosIn, todosIn, toEvent } from "./events.ts";
import { DONE_LIMIT, getTodo, insertTodo, listTodos, parseTodo } from "./todos.ts";

/** 동거인과 공유하는 일정 카테고리 id 들이 들어 있는 자리 (JSON 배열) */
export const GUEST_CATEGORY_KEY = "calendar.guest_category";

export interface SharedCategory {
  id: number;
  name: string;
  color: string;
}

/**
 * 저장된 값 → id 목록. 처음에는 **하나만** 공유하게 만들었다가 여럿으로 늘렸으므로(2026-11-19),
 * 그때 저장된 `"2"` 같은 값도 그대로 읽는다 — 켜 둔 공유가 배포 한 번에 꺼지면 안 된다.
 */
function parseIds(value: string | undefined): number[] {
  if (!value) return [];
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) > 0;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return [...new Set(parsed.map(Number).filter(ok))];
  } catch {
    // 숫자 하나만 들어 있던 옛 형식
  }
  const one = Number(value);
  return ok(one) ? [one] : [];
}

/** 지금 공유 중인 카테고리들. 하나도 없으면 빈 배열 (= 손님에게 아무것도 안 열린다) */
export async function sharedCategories(db: SqlDb): Promise<SharedCategory[]> {
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = ?").bind(GUEST_CATEGORY_KEY).first<{ value: string }>();
  const ids = parseIds(row?.value);
  if (!ids.length) return [];
  // 그새 지워진 카테고리는 저절로 빠진다 (JOIN 이 아니라 존재하는 것만 돌려준다)
  const rows = await db
    .prepare(`SELECT id, name, color FROM calendar_categories WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY sort, id`)
    .bind(...ids)
    .all<SharedCategory>();
  return rows.results;
}

/** 공유할 카테고리들을 정한다. 빈 배열이면 공유를 닫는다 */
export async function setSharedCategories(db: SqlDb, ids: readonly number[]): Promise<void> {
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  if (!clean.length) {
    await db.prepare("DELETE FROM app_meta WHERE key = ?").bind(GUEST_CATEGORY_KEY).run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(GUEST_CATEGORY_KEY, JSON.stringify(clean))
    .run();
}

type GuestEnv = { Bindings: AppBindings; Variables: AppEnv["Variables"] & { cats: SharedCategory[] } };

/** `category_id IN (…)` 조각. 손님 쿼리는 **빠짐없이** 이걸 끼고 돈다 */
const inShared = (cats: readonly SharedCategory[]) => `category_id IN (${cats.map(() => "?").join(", ")})`;
const ids = (cats: readonly SharedCategory[]) => cats.map((c) => c.id);

/** 손님이 만지려는 일정이 **공유 카테고리 것인지**. 아니면(남의 일정이면) 없는 것과 똑같이 404 */
const ownEvent = (db: SqlDb, id: number, cats: readonly SharedCategory[]) =>
  db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE id = ? AND ${inShared(cats)}`)
    .bind(id, ...ids(cats))
    .first<EventRow>();

/** 손님이 만지려는 **할 일**이 공유 카테고리 것인지. 카테고리는 일정 것을 같이 쓴다 */
const ownTodo = (db: SqlDb, id: number, cats: readonly SharedCategory[]) => getTodo(db, id, ids(cats));

/** 사진이 붙는 곳 — 일정이거나 할 일이거나 */
type PhotoTarget = "calendar" | "todo";
const photoTarget = (v: string | undefined): PhotoTarget => (v === "todo" ? "todo" : "calendar");
const ownRef = async (db: SqlDb, app: PhotoTarget, id: number, cats: readonly SharedCategory[]): Promise<boolean> =>
  app === "todo" ? !!(await ownTodo(db, id, cats)) : !!(await ownEvent(db, id, cats));

/** 서울 날짜 (할 일 기한을 '이번 주·이번 달' 로 계산할 때 쓴다) */
const seoulToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

const idParam = (v: string | undefined) => {
  const id = Number(v);
  if (!Number.isInteger(id) || id <= 0) throw new BadRequest("id 가 올바르지 않아요.");
  return id;
};

export function guestApi() {
  const api = new Hono<GuestEnv>();

  // 모든 길목 — 공유 카테고리가 없으면 여기서 끝난다
  api.use(async (c, next) => {
    const cats = await sharedCategories(c.env.DB);
    if (!cats.length) return c.json({ error: "아직 함께 보기로 한 일정이 없어요." }, 403);
    c.set("cats", cats);
    return next();
  });

  /** 지금 누가 보고 있나 (주인 쪽과 같은 표). 데이터 변경이 아니므로 버전을 올리지 않는다 */
  api.post("/presence", async (c) => {
    c.set("skipRevBump", true);
    return c.json(await touchPresence(c.env.DB, "guest"));
  });

  /** 그 기간의 공유 카테고리 일정 (반복은 화면이 펼친다) */
  api.get("/events", async (c) => {
    const from = c.req.query("from") ?? "";
    const to = c.req.query("to") ?? "";
    if (!DATE.test(from) || !DATE.test(to) || to < from || daysBetween(from, to) > 400) throw new BadRequest("기간이 올바르지 않아요.");
    const cats = c.get("cats");
    const [once, repeating] = await Promise.all([
      c.env.DB.prepare(
        `SELECT ${EVENT_COLUMNS} FROM calendar_events
         WHERE ${inShared(cats)} AND repeat IS NULL AND start_date BETWEEN ? AND ? AND end_date >= ?`,
      )
        .bind(...ids(cats), addDays(from, -MAX_SPAN_DAYS), to, from)
        .all<EventRow>(),
      c.env.DB.prepare(
        `SELECT ${EVENT_COLUMNS} FROM calendar_events
         WHERE ${inShared(cats)} AND repeat IS NOT NULL AND start_date <= ? AND (repeat_until IS NULL OR repeat_until >= ?)`,
      )
        .bind(...ids(cats), to, addDays(from, -MAX_SPAN_DAYS))
        .all<EventRow>(),
    ]);
    const events: CalendarEvent[] = [...once.results, ...repeating.results].map(toEvent);
    // 날짜를 콕 집어 둔 할 일도 한 줄씩 (공유 카테고리 것만)
    const todos = await todosIn(c.env.DB, from, to, ids(cats));
    return c.json({ events, categories: cats, todos });
  });

  /** 새 일정. 카테고리는 **공유 목록 안에서만** 고를 수 있다 (목록 밖 값은 첫 번째로 떨어진다) */
  api.post("/events", async (c) => {
    const cats = c.get("cats");
    const asked = parseEvent(await c.req.json());
    const categoryId = cats.some((x) => x.id === asked.categoryId) ? asked.categoryId : cats[0]!.id;
    const row = await insertEvent(c.env.DB, { ...asked, categoryId }).first<{ id: number }>();
    const saved = await ownEvent(c.env.DB, row!.id, cats);
    return c.json(toEvent(saved!), 201);
  });

  api.put("/events/:id", async (c) => {
    const cats = c.get("cats");
    const id = idParam(c.req.param("id"));
    const e = parseEvent(await c.req.json());
    // 분류도 바꿀 수 있지만 **공유 목록 안에서만**. 목록 밖을 보내면 있던 분류 그대로 둔다
    const keep = await ownEvent(c.env.DB, id, cats);
    if (!keep) return c.json({ error: "일정이 없어요." }, 404);
    const categoryId = cats.some((x) => x.id === e.categoryId) ? e.categoryId : keep.categoryId;
    const res = await c.env.DB.prepare(
      `UPDATE calendar_events SET category_id = ?, title = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?,
         location = ?, memo = ?, repeat = ?, repeat_until = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND ${inShared(cats)}`,
    )
      .bind(categoryId, e.title, e.startDate, e.endDate, e.startTime, e.endTime, e.location, e.memo, e.repeat, e.repeatUntil, id, ...ids(cats))
      .run();
    if (!res.meta.changes) return c.json({ error: "일정이 없어요." }, 404);
    return c.json(toEvent((await ownEvent(c.env.DB, id, cats))!));
  });

  api.delete("/events/:id", async (c) => {
    const cats = c.get("cats");
    const id = idParam(c.req.param("id"));
    const res = await c.env.DB.prepare(`DELETE FROM calendar_events WHERE id = ? AND ${inShared(cats)}`)
      .bind(id, ...ids(cats))
      .run();
    if (!res.meta.changes) return c.json({ error: "일정이 없어요." }, 404);
    await dropPhotos(c.env.DB, c.env.PHOTOS, "calendar", [id]);
    return c.json({ ok: true });
  });

  /** 반복 일정의 한 회차만 빼기(body.event 없음) 또는 그 회차만 바꾸기 */
  api.post("/events/:id/occurrence", async (c) => {
    const cats = c.get("cats");
    const id = idParam(c.req.param("id"));
    const body = (await c.req.json()) as { date?: unknown; event?: unknown };
    const date = typeof body.date === "string" && DATE.test(body.date) ? body.date : null;
    if (!date) throw new BadRequest("날짜가 올바르지 않아요.");
    const row = await ownEvent(c.env.DB, id, cats);
    const event = row ? toEvent(row) : null;
    if (!event?.repeat) return c.json({ error: "반복 일정이 아니에요." }, 404);
    const replacement = body.event ? { ...parseEvent({ ...(body.event as object), repeat: null }), categoryId: event.categoryId } : null;
    const skip = json([...new Set([...event.skipDates, date])].sort());
    const statements = [
      c.env.DB.prepare(`UPDATE calendar_events SET skip_dates = ? WHERE id = ? AND ${inShared(cats)}`).bind(skip, id, ...ids(cats)),
    ];
    if (replacement) statements.push(insertEvent(c.env.DB, replacement));
    await c.env.DB.batch(statements);
    return c.json({ ok: true });
  });

  /* ── 할 일 ─────────────────────────────────────────────────
     일정과 같은 카테고리를 쓴다 — '함께 보기' 를 켠 카테고리의 할 일이 그대로 열린다.
     여기 쿼리도 전부 공유 카테고리를 박고 돈다(listTodos·getTodo 에 ids 를 넘긴다). */

  api.get("/todos", async (c) => {
    const cats = c.get("cats");
    const [open, done] = await Promise.all([listTodos(c.env.DB, false, ids(cats)), listTodos(c.env.DB, true, ids(cats))]);
    return c.json({ open, done, categories: cats, doneLimit: DONE_LIMIT, today: seoulToday() });
  });

  /** 새 할 일. 카테고리는 **공유 목록 안에서만** (목록 밖 값은 첫 번째로 떨어진다) */
  api.post("/todos", async (c) => {
    const cats = c.get("cats");
    const asked = parseTodo(await c.req.json(), seoulToday());
    const categoryId = cats.some((x) => x.id === asked.categoryId) ? asked.categoryId : cats[0]!.id;
    const row = await insertTodo(c.env.DB, { ...asked, categoryId }).first<{ id: number }>();
    return c.json(await ownTodo(c.env.DB, row!.id, cats), 201);
  });

  api.put("/todos/:id", async (c) => {
    const cats = c.get("cats");
    const id = idParam(c.req.param("id"));
    if (!(await ownTodo(c.env.DB, id, cats))) return c.json({ error: "할 일이 없어요." }, 404);
    const asked = parseTodo(await c.req.json(), seoulToday());
    const categoryId = cats.some((x) => x.id === asked.categoryId) ? asked.categoryId : cats[0]!.id;
    await c.env.DB.prepare(`UPDATE calendar_todos SET category_id = ?, title = ?, memo = ?, due_kind = ?, due_date = ? WHERE id = ? AND ${inShared(cats)}`)
      .bind(categoryId, asked.title, asked.memo, asked.dueKind, asked.dueDate, id, ...ids(cats))
      .run();
    return c.json(await ownTodo(c.env.DB, id, cats));
  });

  api.post("/todos/:id/done", async (c) => {
    const cats = c.get("cats");
    const id = idParam(c.req.param("id"));
    const body = (await c.req.json()) as { done?: unknown };
    const res = await c.env.DB.prepare(
      `UPDATE calendar_todos SET done_at = ${body.done === false ? "NULL" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"} WHERE id = ? AND ${inShared(cats)}`,
    )
      .bind(id, ...ids(cats))
      .run();
    if (!res.meta.changes) return c.json({ error: "할 일이 없어요." }, 404);
    return c.json(await ownTodo(c.env.DB, id, cats));
  });

  api.delete("/todos/:id", async (c) => {
    const cats = c.get("cats");
    const id = idParam(c.req.param("id"));
    if (!(await ownTodo(c.env.DB, id, cats))) return c.json({ error: "할 일이 없어요." }, 404);
    await c.env.DB.prepare(`DELETE FROM calendar_todos WHERE id = ? AND ${inShared(cats)}`).bind(id, ...ids(cats)).run();
    await dropPhotos(c.env.DB, c.env.PHOTOS, "todo", [id]);
    return c.json({ ok: true });
  });

  /* ── 사진 ─────────────────────────────────────────────────────
   * 일정·할 일에 붙는 사진만. 어느 쪽이든 **그것이 공유 카테고리 것인지 먼저 보고** 움직인다 —
   * ref 를 그대로 믿으면 남의 사진을 번호만 바꿔 가져갈 수 있다. */

  api.get("/photos", async (c) => {
    const id = idParam(c.req.query("ref"));
    const app = photoTarget(c.req.query("app"));
    if (!(await ownRef(c.env.DB, app, id, c.get("cats")))) return c.json({ photos: [], max: PHOTO_MAX, enabled: Boolean(c.env.PHOTOS) });
    const rows = await c.env.DB.prepare("SELECT id, width, height FROM core_photos WHERE app = ? AND ref = ? ORDER BY created_at, id")
      .bind(app, String(id))
      .all<{ id: string; width: number | null; height: number | null }>()
      .catch(() => ({ results: [] }));
    return c.json({ photos: rows.results, max: PHOTO_MAX, enabled: Boolean(c.env.PHOTOS) });
  });

  /** 그 달 사진 모아 보기 — 공유 카테고리 것만 */
  api.get("/photos/month", async (c) =>
    c.json({ photos: await photosIn(c.env.DB, c.req.query("from") ?? "", c.req.query("to") ?? "", ids(c.get("cats"))) }),
  );

  /** 사진이 붙은 일정 (줄에 작은 카메라). 가계부(app=ledger)는 손님에게 늘 빈 값 */
  api.get("/photos/marks", async (c) => {
    const app = c.req.query("app");
    // 가계부(app=ledger)는 손님에게 늘 빈 값
    if (app !== "calendar" && app !== "todo") return c.json({ marks: {} });
    const cats = c.get("cats");
    const table = app === "todo" ? "calendar_todos" : "calendar_events";
    const rows = await c.env.DB.prepare(
      `SELECT p.ref AS ref, count(*) AS n FROM core_photos p JOIN ${table} e ON e.id = CAST(p.ref AS INTEGER)
       WHERE p.app = ? AND e.${inShared(cats)} GROUP BY p.ref`,
    )
      .bind(app, ...ids(cats))
      .all<{ ref: string; n: number }>()
      .catch(() => ({ results: [] }));
    return c.json({ marks: Object.fromEntries(rows.results.map((r) => [r.ref, r.n])) });
  });

  api.post("/photos", async (c) => {
    if (!c.env.PHOTOS) return c.json({ error: "사진 기능이 아직 켜져 있지 않아요" }, 503);
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "올린 내용을 읽지 못했어요" }, 400);
    const id = idParam(String(form.get("ref") ?? ""));
    const app = photoTarget(String(form.get("app") ?? ""));
    if (!(await ownRef(c.env.DB, app, id, c.get("cats")))) return c.json({ error: "붙일 곳을 찾을 수 없어요" }, 404);
    const full = form.get("full"), thumb = form.get("thumb");
    if (!(full instanceof File) || !(thumb instanceof File)) return c.json({ error: "사진이 비어 있어요" }, 400);
    const [fb, tb] = await Promise.all([full.arrayBuffer(), thumb.arrayBuffer()]);
    const dim = (k: string) => {
      const n = Number(form.get(k));
      return Number.isInteger(n) && n > 0 && n <= 10000 ? n : null;
    };
    const saved = await savePhoto(c.env.DB, c.env.PHOTOS, app, String(id), fb, tb, { w: dim("w"), h: dim("h") });
    if ("error" in saved) return c.json({ error: saved.error }, saved.status);
    return c.json({ id: saved.id });
  });

  api.delete("/photos/:id", async (c) => {
    const photoId = c.req.param("id");
    const ref = await photoOwner(c.env.DB, photoId, c.get("cats"));
    if (ref === null) return c.json({ error: "not_found" }, 404);
    await c.env.DB.prepare("DELETE FROM core_photos WHERE id = ?").bind(photoId).run();
    if (c.env.PHOTOS) await Promise.all([c.env.PHOTOS.delete(photoKey(photoId)), c.env.PHOTOS.delete(photoKey(photoId, true))]).catch(() => {});
    return c.json({ ok: true });
  });

  api.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "요청 형식이 올바르지 않아요." }, 400);
    if (err instanceof ReadBudgetError) {
      console.error(err.message, c.req.path);
      return c.json({ error: "너무 많이 읽어서 멈췄어요." }, 503);
    }
    console.error(err);
    return c.json({ error: "서버에서 문제가 생겼어요." }, 500);
  });

  return api;
}

/** 이 사진이 공유 카테고리 일정에 붙은 것인가. 맞으면 그 일정 id, 아니면 null */
export async function photoOwner(db: SqlDb, photoId: string, cats: readonly SharedCategory[]): Promise<number | null> {
  if (!/^[0-9a-f]{32}$/.test(photoId) || !cats.length) return null;
  // 먼저 **어디에 붙은 사진인지**부터 본다. 한 쿼리로 두 표를 보게 하면 할 일 표가 아직
  // 없을 때(배포는 코드 → 마이그레이션 순서다) 일정 사진까지 통째로 안 보이게 된다
  const p = await db
    .prepare("SELECT app, ref FROM core_photos WHERE id = ?")
    .bind(photoId)
    .first<{ app: string; ref: string }>()
    .catch(() => null);
  if (!p) return null;
  const ref = Number(p.ref);
  if (!Number.isInteger(ref) || ref <= 0) return null;
  if (p.app === "todo") return (await ownTodo(db, ref, cats).catch(() => null)) ? ref : null;
  if (p.app !== "calendar") return null;
  return (await ownEvent(db, ref, cats).catch(() => null)) ? ref : null;
}

/**
 * 손님용 사진 바이트. host 의 ETag 미들웨어 **앞에** 붙는다 (사진은 안 바뀌니 오래 캐시한다).
 * 미들웨어 밖이라 공유 카테고리 확인을 여기서 직접 한다.
 */
export function guestPhotoFileRoute() {
  const api = new Hono<GuestEnv>();
  api.get("/:id", async (c) => {
    const cats = await sharedCategories(c.env.DB);
    if (!cats.length) return c.json({ error: "not_found" }, 404);
    const photoId = c.req.param("id");
    if ((await photoOwner(c.env.DB, photoId, cats)) === null) return c.json({ error: "not_found" }, 404);
    if (!c.env.PHOTOS) return c.json({ error: "사진 기능이 아직 켜져 있지 않아요" }, 503);
    const buf = await c.env.PHOTOS.get(photoKey(photoId, c.req.query("t") === "1"), "arrayBuffer");
    if (!buf) return c.json({ error: "not_found" }, 404);
    return c.body(buf, 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" });
  });
  return api;
}
