/**
 * 일정 데이터 다루기 — 일정 API(index.ts)와 **손님 API(guest.ts)가 함께 쓴다.**
 *
 * 손님(동거인)에게는 공유 카테고리 하나만 열리는데, 그 거르기를 손님 쪽 쿼리에 직접 박으려면
 * 여기 조각들이 양쪽에서 필요하다. 한쪽이 다른 쪽을 import 하면 순환이 되므로 가운데로 뺐다.
 */
import { json, type SqlDb } from "@homebase/db";
import { addDays, daysBetween, type CalendarEvent, MAX_SPAN_DAYS } from "../shared/occurrences.ts";

export interface Category {
  id: number;
  name: string;
  color: string;
  hidden: boolean;
  sort: number;
}

export const COLORS = ["blue", "green", "red", "orange", "purple", "teal", "gray"] as const;

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class BadRequest extends Error {}

export const EVENT_COLUMNS = `id, category_id AS categoryId, title, start_date AS startDate, end_date AS endDate,
  start_time AS startTime, end_time AS endTime, location, memo, repeat, repeat_until AS repeatUntil, skip_dates AS skipDates,
  created_at AS createdAt`;

export type EventRow = Omit<CalendarEvent, "skipDates"> & { skipDates: string };
export const toEvent = (r: EventRow): CalendarEvent => ({ ...r, skipDates: JSON.parse(r.skipDates) as string[] });

/** 저장할 일정 값 검사. 틀리면 BadRequest */
export function parseEvent(body: unknown): Omit<CalendarEvent, "id" | "skipDates" | "createdAt"> {
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

export async function getEvent(db: SqlDb, id: number): Promise<CalendarEvent | null> {
  const row = await db.prepare(`SELECT ${EVENT_COLUMNS} FROM calendar_events WHERE id = ?`).bind(id).first<EventRow>();
  return row ? toEvent(row) : null;
}

export const insertEvent = (db: SqlDb, e: Omit<CalendarEvent, "id" | "skipDates" | "createdAt">) =>
  db
    .prepare(
      `INSERT INTO calendar_events (category_id, title, start_date, end_date, start_time, end_time, location, memo, repeat, repeat_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(e.categoryId, e.title, e.startDate, e.endDate, e.startTime, e.endTime, e.location, e.memo, e.repeat, e.repeatUntil);

export async function listCategories(db: SqlDb): Promise<Category[]> {
  const rows = await db
    .prepare("SELECT id, name, color, hidden, sort FROM calendar_categories ORDER BY sort, id")
    .all<{ id: number; name: string; color: string; hidden: number; sort: number }>();
  return rows.results.map((r) => ({ ...r, hidden: r.hidden === 1 }));
}

/** [from, to] 에 보일 수 있는 일정 원본(반복은 펼치지 않음)과 카테고리. 한 번짜리는 시작일 인덱스로 from-62일 ~ to 만 */
export async function eventsIn(db: SqlDb, from: string, to: string): Promise<{ events: CalendarEvent[]; categories: Category[] }> {
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

/** 모아 보기 한 장 — 썸네일만 쓰므로 바이트는 안 담는다 */
export interface MonthPhoto {
  id: string;
  width: number | null;
  height: number | null;
  /** 붙어 있는 일정 id */
  ref: string;
  date: string;
  title: string;
  categoryId: number | null;
}

/**
 * 그 기간 일정에 붙은 사진들 (모아 보기).
 *
 * **한 달씩 끊어서** 부른다 — 사진이 쌓여도 한 번에 받는 양이 일정하다. 화면은 썸네일(320px,
 * 장당 ~25KB)만 lazy 로 받고, 사진 주소는 1년 immutable 이라 두 번째부터는 네트워크를 안 탄다.
 *
 * 반복 일정의 사진은 **시작일**에 모인다 — 사진은 회차가 아니라 일정에 붙기 때문이다.
 * 표가 아직 없으면 조용히 빈 값 (배포는 코드 → 마이그레이션 순서다).
 */
export async function photosIn(db: SqlDb, from: string, to: string, catIds?: readonly number[]): Promise<MonthPhoto[]> {
  if (!DATE.test(from) || !DATE.test(to) || to < from || daysBetween(from, to) > 400) throw new BadRequest("기간이 올바르지 않아요.");
  if (catIds && !catIds.length) return [];
  const limit = catIds ? ` AND e.category_id IN (${catIds.map(() => "?").join(", ")})` : "";
  const rows = await db
    .prepare(
      `SELECT p.id AS id, p.width AS width, p.height AS height, p.ref AS ref,
              e.start_date AS date, e.title AS title, e.category_id AS categoryId
       FROM core_photos p JOIN calendar_events e ON e.id = CAST(p.ref AS INTEGER)
       WHERE p.app = 'calendar' AND e.start_date BETWEEN ? AND ?${limit}
       ORDER BY e.start_date DESC, p.created_at`,
    )
    .bind(from, to, ...(catIds ?? []))
    .all<MonthPhoto>()
    .catch(() => ({ results: [] }));
  return rows.results;
}
