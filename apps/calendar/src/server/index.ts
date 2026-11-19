import { Hono } from "hono";
import type { AppEnv, ServerModule } from "@homebase/core/server";
import { json, ReadBudgetError, type SqlDb, type SqlValue } from "@homebase/db";
import { dropPhotos } from "@homebase/core/photos";
import { addDays, daysBetween, expandEvents, MAX_SPAN_DAYS, timeLabel, type CalendarEvent } from "../shared/occurrences.ts";

export const calendarServer: ServerModule = {
  id: "calendar",
  createApi: createCalendarApi,
};

export interface Category {
  id: number;
  name: string;
  color: string;
  hidden: boolean;
  sort: number;
}

export const COLORS = ["blue", "green", "red", "orange", "purple", "teal", "gray"] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

class BadRequest extends Error {}

const EVENT_COLUMNS = `id, category_id AS categoryId, title, start_date AS startDate, end_date AS endDate,
  start_time AS startTime, end_time AS endTime, location, memo, repeat, repeat_until AS repeatUntil, skip_dates AS skipDates`;

type EventRow = Omit<CalendarEvent, "skipDates"> & { skipDates: string };
const toEvent = (r: EventRow): CalendarEvent => ({ ...r, skipDates: JSON.parse(r.skipDates) as string[] });

/** 저장할 일정 값 검사. 틀리면 BadRequest */
export function parseEvent(body: unknown): Omit<CalendarEvent, "id" | "skipDates"> {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const title = str(b.title, 200);
  if (!title) throw new BadRequest("제목을 적어 주세요.");
  const startDate = typeof b.startDate === "string" && DATE.test(b.startDate) ? b.startDate : null;
  const endDate = b.endDate === undefined || b.endDate === null ? startDate : typeof b.endDate === "string" && DATE.test(b.endDate) ? b.endDate : null;
  if (!startDate || !endDate) throw new BadRequest("날짜가 올바르지 않아요.");
  if (endDate < startDate) throw new BadRequest("끝 날짜가 시작 날짜보다 앞이에요.");
  if (daysBetween(startDate, endDate) > MAX_SPAN_DAYS) throw new BadRequest(`일정은 ${MAX_SPAN_DAYS + 1}일까지만 이어질 수 있어요.`);
  const time = (v: unknown) => (v === null || v === undefined || v === "" ? null : typeof v === "string" && TIME.test(v) ? v : undefined);
  const startTime = time(b.startTime);
  const endTime = time(b.endTime);
  if (startTime === undefined || endTime === undefined) throw new BadRequest("시각이 올바르지 않아요.");
  if (!startTime && endTime) throw new BadRequest("시작 시각을 적어 주세요.");
  if (startTime && endTime && startDate === endDate && endTime < startTime) throw new BadRequest("끝 시각이 시작 시각보다 앞이에요.");
  const repeat = b.repeat === "weekly" || b.repeat === "monthly" || b.repeat === "yearly" ? b.repeat : null;
  if (b.repeat !== undefined && b.repeat !== null && !repeat) throw new BadRequest("반복이 올바르지 않아요.");
  const repeatUntil = repeat && typeof b.repeatUntil === "string" && DATE.test(b.repeatUntil) ? b.repeatUntil : null;
  if (repeatUntil && repeatUntil < startDate) throw new BadRequest("반복 끝 날짜가 시작 날짜보다 앞이에요.");
  const categoryId = typeof b.categoryId === "number" && Number.isInteger(b.categoryId) ? b.categoryId : null;
  return { categoryId, title, startDate, endDate, startTime, endTime: startTime ? endTime : null, location: str(b.location, 200), memo: str(b.memo, 2000), repeat, repeatUntil };
}

async function getEvent(db: SqlDb, id: number): Promise<CalendarEvent | null> {
  const row = await db.prepare(`SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE id = ?`).bind(id).first<EventRow>();
  return row ? toEvent(row) : null;
}

const insertEvent = (db: SqlDb, e: Omit<CalendarEvent, "id" | "skipDates">) =>
  db
    .prepare(
      `INSERT INTO calendar_events (category_id, title, start_date, end_date, start_time, end_time, location, memo, repeat, repeat_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(e.categoryId, e.title, e.startDate, e.endDate, e.startTime, e.endTime, e.location, e.memo, e.repeat, e.repeatUntil);

async function listCategories(db: SqlDb): Promise<Category[]> {
  const rows = await db
    .prepare("SELECT id, name, color, hidden, sort FROM calendar_categories ORDER BY sort, id")
    .all<{ id: number; name: string; color: string; hidden: number; sort: number }>();
  return rows.results.map((r) => ({ ...r, hidden: r.hidden === 1 }));
}

/** [from, to] 에 보일 수 있는 일정 원본(반복은 펼치지 않음)과 카테고리. 한 번짜리는 시작일 인덱스로 from-62일 ~ to 만 */
async function eventsIn(db: SqlDb, from: string, to: string): Promise<{ events: CalendarEvent[]; categories: Category[] }> {
  if (!DATE.test(from) || !DATE.test(to) || to < from || daysBetween(from, to) > 400) throw new BadRequest("기간이 올바르지 않아요.");
  const [once, repeating, categories] = await Promise.all([
    db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE repeat IS NULL AND start_date BETWEEN ? AND ? AND end_date >= ?`)
      .bind(addDays(from, -MAX_SPAN_DAYS), to, from)
      .all<EventRow>(),
    db
      .prepare(`SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE repeat IS NOT NULL AND start_date <= ? AND (repeat_until IS NULL OR repeat_until >= ?)`)
      .bind(to, addDays(from, -MAX_SPAN_DAYS))
      .all<EventRow>(),
    listCategories(db),
  ]);
  return { events: [...once.results, ...repeating.results].map(toEvent), categories };
}

/** 서울 날짜 (일정은 Asia/Seoul 고정) */
const seoulToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

const SEARCH_LIMIT = 200;
/** 반복 일정의 '언제 것을 보여 줄까' 를 찾는 창 (오늘 앞뒤로). 읽기는 안 늘고 JS 계산만 한다 */
const NEAR_DAYS = 400;

/**
 * 찾은 일정마다 **보여 줄 날짜**를 정한다.
 * 한 번짜리는 시작일. 반복은 오늘 기준으로 **다음 회차**(없으면 마지막 회차)를 보여 준다 —
 * 2년 전에 시작한 매주 일정의 시작일을 보여 줘 봐야 쓸 데가 없다.
 */
export function searchDates(events: CalendarEvent[], today: string): Map<number, string> {
  const out = new Map<number, string>();
  const repeating = events.filter((e) => e.repeat);
  for (const e of events) if (!e.repeat) out.set(e.id, e.startDate);
  if (repeating.length === 0) return out;
  const byEvent = new Map<number, string[]>();
  for (const [date, list] of expandEvents(repeating, addDays(today, -NEAR_DAYS), addDays(today, NEAR_DAYS))) {
    for (const o of list) if (o.date === o.start) byEvent.set(o.event.id, [...(byEvent.get(o.event.id) ?? []), date]);
  }
  for (const e of repeating) {
    const dates = (byEvent.get(e.id) ?? []).sort();
    out.set(e.id, dates.find((d) => d >= today) ?? dates[dates.length - 1] ?? e.startDate);
  }
  return out;
}

function createCalendarApi() {
  const api = new Hono<AppEnv>();
  const idParam = (v: string) => {
    const id = Number(v);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequest("id 가 올바르지 않아요.");
    return id;
  };

  /** [from, to] 에 보일 수 있는 일정 원본 + 카테고리 (일정 화면이 펼친다) */
  api.get("/events", async (c) => c.json(await eventsIn(c.env.DB, c.req.query("from") ?? "", c.req.query("to") ?? "")));

  /**
   * 다른 앱(가계부 달력)용: [from, to] 날짜별로 펼친 일정. 끈 카테고리는 뺀다.
   * 가계부가 일정 코드를 가져다 쓰지 않게(패키지 순환) 여기서 펼쳐서 준다.
   */
  api.get("/days", async (c) => {
    const from = c.req.query("from") ?? "";
    const to = c.req.query("to") ?? "";
    const { events, categories } = await eventsIn(c.env.DB, from, to);
    const byId = new Map(categories.map((x) => [x.id, x]));
    const shown = events.filter((e) => e.categoryId === null || !byId.get(e.categoryId)?.hidden);
    const days: Record<string, { id: number; title: string; time: string; color: string; location: string | null }[]> = {};
    for (const [date, list] of expandEvents(shown, from, to)) {
      days[date] = list.map((o) => ({
        id: o.event.id,
        title: o.event.title,
        time: timeLabel(o),
        color: (o.event.categoryId !== null ? byId.get(o.event.categoryId)?.color : undefined) ?? "gray",
        location: o.event.location,
      }));
    }
    return c.json({ days });
  });

  /**
   * 일정 검색 — 제목·장소·메모·카테고리 이름. 띄어쓰기로 나눈 말은 **모두** 맞아야 한다(AND).
   * 가계부 검색(`ledger/server/index.ts`)과 같은 규칙이라 쓰는 사람이 두 가지를 외우지 않아도 된다.
   */
  api.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 50);
    const categories = await listCategories(c.env.DB);
    if (!q) return c.json({ results: [], more: false, categories });
    const terms = [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, 5);
    const where: string[] = [];
    const binds: SqlValue[] = [];
    for (const term of terms) {
      const lower = term.toLowerCase();
      const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const catHit = categories.filter((x) => x.name.toLowerCase().includes(lower)).map((x) => x.id);
      where.push(
        `(title LIKE ? ESCAPE '\\' OR ifnull(location, '') LIKE ? ESCAPE '\\' OR ifnull(memo, '') LIKE ? ESCAPE '\\'
          OR category_id IN (SELECT value FROM json_each(?)))`,
      );
      binds.push(like, like, like, json(catHit));
    }
    const rows = await c.env.DB.prepare(
      `SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE ${where.join(" AND ")} ORDER BY start_date DESC, id DESC LIMIT ${SEARCH_LIMIT + 1}`,
    )
      .bind(...binds)
      .all<EventRow>();
    const events = rows.results.slice(0, SEARCH_LIMIT).map(toEvent);
    const dates = searchDates(events, seoulToday());
    // 보여 줄 날짜가 늦은 것부터 — 앞으로 올 일정이 위로 온다
    const results = events
      .map((event) => ({ event, date: dates.get(event.id) ?? event.startDate }))
      .sort((a, b) => b.date.localeCompare(a.date) || b.event.id - a.event.id);
    return c.json({ results, more: rows.results.length > SEARCH_LIMIT, categories });
  });

  api.post("/events", async (c) => {
    const e = parseEvent(await c.req.json());
    const row = await insertEvent(c.env.DB, e).first<{ id: number }>();
    return c.json(await getEvent(c.env.DB, row!.id), 201);
  });

  /** 일정 전체 고치기 (반복이면 모든 회차) */
  api.put("/events/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    const e = parseEvent(await c.req.json());
    const res = await c.env.DB.prepare(
      `UPDATE calendar_events SET category_id = ?, title = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?,
         location = ?, memo = ?, repeat = ?, repeat_until = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
      .bind(e.categoryId, e.title, e.startDate, e.endDate, e.startTime, e.endTime, e.location, e.memo, e.repeat, e.repeatUntil, id)
      .run();
    if (!res.meta.changes) return c.json({ error: "일정이 없어요." }, 404);
    return c.json(await getEvent(c.env.DB, id));
  });

  api.delete("/events/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    await c.env.DB.prepare("DELETE FROM calendar_events WHERE id = ?").bind(id).run();
    await dropPhotos(c.env.DB, c.env.PHOTOS, "calendar", [id]); // 붙인 사진도 같이
    return c.json({ ok: true });
  });

  /**
   * 반복 일정의 한 회차만: 빼기(body.event 없음) 또는 그 회차만 다른 일정으로 바꾸기(body.event).
   * date = 그 회차의 시작일
   */
  api.post("/events/:id/occurrence", async (c) => {
    const id = idParam(c.req.param("id"));
    const body = (await c.req.json()) as { date?: unknown; event?: unknown };
    const date = typeof body.date === "string" && DATE.test(body.date) ? body.date : null;
    if (!date) throw new BadRequest("날짜가 올바르지 않아요.");
    const event = await getEvent(c.env.DB, id);
    if (!event?.repeat) return c.json({ error: "반복 일정이 아니에요." }, 404);
    const replacement = body.event ? parseEvent({ ...(body.event as object), repeat: null }) : null;
    const skip = json([...new Set([...event.skipDates, date])].sort());
    const statements = [c.env.DB.prepare("UPDATE calendar_events SET skip_dates = ? WHERE id = ?").bind(skip, id)];
    if (replacement) statements.push(insertEvent(c.env.DB, replacement));
    await c.env.DB.batch(statements);
    return c.json({ ok: true });
  });

  /** 가져오기 미리보기용: 이미 가져온 일정의 원래 ID들 */
  api.get("/import/uids", async (c) => {
    const rows = await c.env.DB.prepare("SELECT source_uid AS uid FROM calendar_events WHERE source_uid IS NOT NULL").all<{ uid: string }>();
    return c.json(rows.results.map((r) => r.uid));
  });

  /**
   * 가져오기 (구글 캘린더 .ics 를 브라우저에서 읽은 것, 한 번에 500개까지).
   * 카테고리는 이름으로 찾고 없으면 만든다. 같은 원래 ID 는 다시 넣지 않는다.
   */
  api.post("/import", async (c) => {
    const body = (await c.req.json()) as { categories?: unknown; events?: unknown };
    const cats = Array.isArray(body.categories) ? (body.categories as { name?: unknown; color?: unknown }[]) : [];
    const events = Array.isArray(body.events) ? (body.events as Record<string, unknown>[]) : [];
    if (events.length > 500 || cats.length > 50) throw new BadRequest("한 번에 일정 500개, 카테고리 50개까지예요.");
    const existing = await listCategories(c.env.DB);
    const names = new Set(existing.map((x) => x.name));
    const add = cats
      .map((x) => ({ name: typeof x.name === "string" ? x.name.trim().slice(0, 30) : "", color: COLORS.includes(x.color as (typeof COLORS)[number]) ? (x.color as string) : "gray" }))
      .filter((x) => x.name && !names.has(x.name) && (names.add(x.name), true));
    if (add.length) {
      const base = existing.reduce((m, x) => Math.max(m, x.sort), 0);
      await c.env.DB.prepare(
        "INSERT INTO calendar_categories (name, color, sort) SELECT value ->> 'name', value ->> 'color', value ->> 'sort' FROM json_each(?)",
      )
        .bind(json(add.map((x, i) => ({ ...x, sort: base + 1 + i }))))
        .run();
    }
    const byName = new Map((await listCategories(c.env.DB)).map((x) => [x.name, x.id]));
    const rows = events.map((raw) => {
      const e = parseEvent(raw);
      const uid = typeof raw.sourceUid === "string" && raw.sourceUid && raw.sourceUid.length <= 500 ? raw.sourceUid : null;
      if (!uid) throw new BadRequest("원래 ID 가 없어요.");
      const skip = Array.isArray(raw.skipDates) ? (raw.skipDates as unknown[]).filter((d): d is string => typeof d === "string" && DATE.test(d)) : [];
      return { ...e, categoryId: typeof raw.category === "string" ? (byName.get(raw.category) ?? null) : e.categoryId, skipDates: json(skip.slice(0, 500)), uid };
    });
    const res = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO calendar_events (category_id, title, start_date, end_date, start_time, end_time, location, memo, repeat, repeat_until, skip_dates, source_uid)
       SELECT value ->> 'categoryId', value ->> 'title', value ->> 'startDate', value ->> 'endDate', value ->> 'startTime', value ->> 'endTime',
              value ->> 'location', value ->> 'memo', value ->> 'repeat', value ->> 'repeatUntil', value ->> 'skipDates', value ->> 'uid'
       FROM json_each(?)`,
    )
      .bind(json(rows))
      .run();
    return c.json({ inserted: res.meta.changes ?? 0, duplicates: rows.length - (res.meta.changes ?? 0), categories: await listCategories(c.env.DB) });
  });

  api.post("/categories", async (c) => {
    const b = (await c.req.json()) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 30) : "";
    if (!name) throw new BadRequest("이름을 적어 주세요.");
    const color = COLORS.includes(b.color as (typeof COLORS)[number]) ? (b.color as string) : "blue";
    await c.env.DB.prepare("INSERT INTO calendar_categories (name, color, sort) VALUES (?, ?, (SELECT coalesce(max(sort), 0) + 1 FROM calendar_categories))")
      .bind(name, color)
      .run();
    return c.json(await listCategories(c.env.DB), 201);
  });

  /** 이름·색·끄고 보기 */
  api.patch("/categories/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    const b = (await c.req.json()) as Record<string, unknown>;
    const sets: string[] = [];
    const values: SqlValue[] = [];
    if (typeof b.name === "string" && b.name.trim()) sets.push("name = ?"), values.push(b.name.trim().slice(0, 30));
    if (COLORS.includes(b.color as (typeof COLORS)[number])) sets.push("color = ?"), values.push(b.color as string);
    if (typeof b.hidden === "boolean") sets.push("hidden = ?"), values.push(b.hidden ? 1 : 0);
    if (!sets.length) throw new BadRequest("바꿀 값이 없어요.");
    await c.env.DB.prepare(`UPDATE calendar_categories SET ${sets.join(", ")} WHERE id = ?`).bind(...values, id).run();
    return c.json(await listCategories(c.env.DB));
  });

  /** 카테고리를 지우면 그 일정은 카테고리 없음으로 남는다 */
  api.delete("/categories/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE calendar_events SET category_id = NULL WHERE category_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM calendar_categories WHERE id = ?").bind(id),
    ]);
    return c.json(await listCategories(c.env.DB));
  });

  api.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "요청 형식이 올바르지 않아요." }, 400);
    if (err instanceof ReadBudgetError) {
      console.error(err.message, c.req.path);
      return c.json({ error: "DB 를 너무 많이 읽어서 멈췄어요. 이 화면을 알려주세요." }, 503);
    }
    console.error(err);
    return c.json({ error: "서버 오류가 발생했어요." }, 500);
  });

  return api;
}
