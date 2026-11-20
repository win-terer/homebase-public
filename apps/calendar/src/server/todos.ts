/**
 * 할 일 다루기 — 주인 API(index.ts)와 **손님 API(guest.ts)가 함께 쓴다.**
 *
 * 일정과 같은 이유로 가운데에 뒀다(events.ts 주석 참고). 손님 쪽은 여기 조각을 가져다
 * **공유 카테고리를 쿼리에 박아서** 부른다 — 읽어 와서 거르는 게 아니다.
 */
import type { SqlDb } from "@homebase/db";
import { dueDateFor, isDueKind, type Todo, type TodoInput } from "../shared/todos.ts";
import { BadRequest, DATE } from "./events.ts";

export const TODO_COLUMNS = `id, category_id AS categoryId, title, memo, due_kind AS dueKind, due_date AS dueDate,
  done_at AS doneAt, created_at AS createdAt`;

/** 끝낸 것을 한 번에 몇 개까지 보여 줄까. 다 내려 봐야 읽지 않는다 */
export const DONE_LIMIT = 100;

/**
 * 저장할 할 일 값 검사. 틀리면 BadRequest.
 *
 * `dueDate` 는 **보내 온 값을 그대로 믿지 않는다** — kind 에서 다시 계산한다(이번 주는 그 주
 * 토요일, 이번 달은 말일). 화면과 서버가 서로 다른 날짜를 들고 있어도 저장되는 건 하나다.
 */
export function parseTodo(body: unknown, today: string): TodoInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const title = str(b.title, 200);
  if (!title) throw new BadRequest("할 일을 적어 주세요.");
  if (!isDueKind(b.dueKind ?? "someday")) throw new BadRequest("기한이 올바르지 않아요.");
  const dueKind = isDueKind(b.dueKind) ? b.dueKind : "someday";
  const picked = typeof b.dueDate === "string" && DATE.test(b.dueDate) ? b.dueDate : null;
  if (dueKind === "date" && !picked) throw new BadRequest("날짜를 골라 주세요.");
  const categoryId = typeof b.categoryId === "number" && Number.isInteger(b.categoryId) ? b.categoryId : null;
  return { categoryId, title, memo: str(b.memo, 2000), dueKind, dueDate: dueDateFor(dueKind, today, picked) };
}

export const insertTodo = (db: SqlDb, t: TodoInput) =>
  db
    .prepare("INSERT INTO calendar_todos (category_id, title, memo, due_kind, due_date) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(t.categoryId, t.title, t.memo, t.dueKind, t.dueDate);

const inCats = (catIds: readonly number[]) => ` AND category_id IN (${catIds.map(() => "?").join(", ")})`;

/**
 * 안 끝난 것 / 끝낸 것.
 *
 * 안 끝난 것은 **기한 있는 것부터 날짜순**, 기한 없는 것(언젠가)은 뒤로 밀고 최근에 적은 순.
 * 끝낸 것은 최근 것부터 {@link DONE_LIMIT} 개까지만 — 다 내려 받아 봐야 아무도 안 읽는다.
 */
export async function listTodos(db: SqlDb, done: boolean, catIds?: readonly number[]): Promise<Todo[]> {
  if (catIds && !catIds.length) return [];
  const where = `done_at IS ${done ? "NOT " : ""}NULL${catIds ? inCats(catIds) : ""}`;
  const order = done ? "done_at DESC" : "due_date IS NULL, due_date, created_at DESC";
  const rows = await db
    .prepare(`SELECT ${TODO_COLUMNS} FROM calendar_todos WHERE ${where} ORDER BY ${order}${done ? ` LIMIT ${DONE_LIMIT}` : ""}`)
    .bind(...(catIds ?? []))
    .all<Todo>()
    .catch(() => ({ results: [] })); // 표가 아직 없으면 조용히 빈 값 (배포는 코드 → 마이그레이션 순서다)
  return rows.results;
}

/** 한 건. `catIds` 를 주면 **그 카테고리 것이 아니면 못 찾는다** (손님 길) */
export async function getTodo(db: SqlDb, id: number, catIds?: readonly number[]): Promise<Todo | null> {
  if (catIds && !catIds.length) return null;
  return (
    (await db
      .prepare(`SELECT ${TODO_COLUMNS} FROM calendar_todos WHERE id = ?${catIds ? inCats(catIds) : ""}`)
      .bind(id, ...(catIds ?? []))
      .first<Todo>()) ?? null
  );
}
