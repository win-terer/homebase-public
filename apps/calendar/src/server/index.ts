import { Hono } from "hono";
import type { AppEnv, ServerModule } from "@homebase/core/server";
import { json, ReadBudgetError, type SqlDb, type SqlValue } from "@homebase/db";
import { dropPhotos } from "@homebase/core/photos";
import { addDays, daysBetween, expandEvents, MAX_SPAN_DAYS, timeLabel, type CalendarEvent } from "../shared/occurrences.ts";

export const calendarServer: ServerModule = {
  id: "calendar",
  createApi: createCalendarApi,
};

import {
  BadRequest,
  type Category,
  COLORS,
  DATE,
  EVENT_COLUMNS,
  type EventRow,
  eventsIn,
  getEvent,
  insertEvent,
  listCategories,
  parseEvent,
  photosIn,
  TIME,
  toEvent,
} from "./events.ts";
import { DONE_LIMIT, getTodo, insertTodo, listTodos, parseTodo } from "./todos.ts";
import { presenceNames, setPresenceNames, touchPresence } from "@homebase/core/presence";
import { setSharedCategories, sharedCategories } from "./guest.ts";

export { COLORS, parseEvent, type Category };


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

  /* ── 할 일 ─────────────────────────────────────────────────
     날짜가 없는 것까지 담으려고 일정과 **표를 따로** 뒀다. 카테고리는 일정 것을 같이 쓰므로
     '함께 보기' 를 켠 카테고리면 할 일도 동거인에게 열린다 (guest.ts). */

  api.get("/todos", async (c) => {
    const [open, done, categories] = await Promise.all([listTodos(c.env.DB, false), listTodos(c.env.DB, true), listCategories(c.env.DB)]);
    return c.json({ open, done, categories, doneLimit: DONE_LIMIT, today: seoulToday() });
  });

  api.post("/todos", async (c) => {
    const t = parseTodo(await c.req.json(), seoulToday());
    const row = await insertTodo(c.env.DB, t).first<{ id: number }>();
    return c.json(await getTodo(c.env.DB, row!.id), 201);
  });

  api.put("/todos/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    const t = parseTodo(await c.req.json(), seoulToday());
    const res = await c.env.DB.prepare("UPDATE calendar_todos SET category_id = ?, title = ?, memo = ?, due_kind = ?, due_date = ? WHERE id = ?")
      .bind(t.categoryId, t.title, t.memo, t.dueKind, t.dueDate, id)
      .run();
    if (!res.meta.changes) return c.json({ error: "할 일이 없어요." }, 404);
    return c.json(await getTodo(c.env.DB, id));
  });

  /** 체크 / 체크 풀기. **지우지 않는다** — 잘못 눌렀을 때 되돌려야 한다 */
  api.post("/todos/:id/done", async (c) => {
    const id = idParam(c.req.param("id"));
    const body = (await c.req.json()) as { done?: unknown };
    const res = await c.env.DB.prepare(`UPDATE calendar_todos SET done_at = ${body.done === false ? "NULL" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"} WHERE id = ?`)
      .bind(id)
      .run();
    if (!res.meta.changes) return c.json({ error: "할 일이 없어요." }, 404);
    return c.json(await getTodo(c.env.DB, id));
  });

  api.delete("/todos/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    await c.env.DB.prepare("DELETE FROM calendar_todos WHERE id = ?").bind(id).run();
    await dropPhotos(c.env.DB, c.env.PHOTOS, "todo", [id]); // 붙인 사진도 같이
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

  /** 그 달 일정에 붙은 사진 모아 보기 */
  api.get("/photos", async (c) => c.json({ photos: await photosIn(c.env.DB, c.req.query("from") ?? "", c.req.query("to") ?? "") }));

  /**
   * 지금 누가 보고 있나. 1분마다 온다 — **데이터 버전을 올리지 않는다**(skipRevBump).
   * 올리면 1분마다 화면 캐시가 통째로 깨져서, 느려지지 않으려고 만든 3층 캐시가 무너진다.
   */
  api.post("/presence", async (c) => {
    c.set("skipRevBump", true);
    return c.json(await touchPresence(c.env.DB, "owner"));
  });

  /* ── 동거인과 함께 보기 ───────────────────────────────────────
   * 카테고리 **하나**만 연다. 켜면 그 카테고리 일정이 손님에게 보이고 손님도 적을 수 있다
   * (apps/calendar/src/server/guest.ts). 끄면 그 자리에서 닫힌다. */

  api.get("/guest", async (c) => c.json({ categories: await sharedCategories(c.env.DB), names: await presenceNames(c.env.DB) }));

  /** 서로를 뭐라고 부를지 (접속 표시에 쓴다). 이름은 **설정에만** 둔다 */
  api.put("/names", async (c) => {
    const body = (await c.req.json()) as { owner?: unknown; guest?: unknown };
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    await setPresenceNames(c.env.DB, { owner: str(body.owner), guest: str(body.guest) });
    return c.json({ names: await presenceNames(c.env.DB) });
  });

  api.put("/guest", async (c) => {
    const body = (await c.req.json()) as { categoryIds?: unknown };
    if (!Array.isArray(body.categoryIds)) throw new BadRequest("함께 볼 카테고리를 보내 주세요.");
    const wanted = [...new Set(body.categoryIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (wanted.length > 20) throw new BadRequest("너무 많아요.");
    if (wanted.length) {
      // 없는 카테고리를 넣어 두면 지운 번호를 새 카테고리가 물려받아 저절로 열린다
      const rows = await c.env.DB.prepare(`SELECT id FROM calendar_categories WHERE id IN (${wanted.map(() => "?").join(", ")})`)
        .bind(...wanted)
        .all<{ id: number }>();
      if (rows.results.length !== wanted.length) return c.json({ error: "없는 카테고리가 섞여 있어요." }, 404);
    }
    await setSharedCategories(c.env.DB, wanted);
    return c.json({ categories: await sharedCategories(c.env.DB) });
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
    // 함께 보던 카테고리였다면 공유 목록에서도 뺀다. 남겨 두면 **지운 id 를 새 카테고리가
    // 물려받아** 만들자마자 동거인에게 열린다 (SQLite 는 지운 번호를 다시 쓴다).
    const still = await sharedCategories(c.env.DB);
    await setSharedCategories(c.env.DB, still.map((x) => x.id).filter((x) => x !== id));
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
