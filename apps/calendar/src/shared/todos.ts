/**
 * 할 일 — 서버와 화면이 같이 쓰는 모양·규칙.
 *
 * 기한은 **러프하게** 정할 수 있다(사용자 요청 2026-11-20): 언젠가 · 이번 주 · 이번 달 · 날짜 지정.
 * 저장할 때 week·month 는 **그 기간의 마지막 날**을 같이 적어 둔다 — 그래야 정렬도 '지났나' 도
 * 한 칸으로 끝나고, 다음 주가 되면 '이번 주' 라고 적어 둔 것이 제대로 지난 것이 된다.
 */
export type DueKind = "someday" | "week" | "month" | "date";

/** 화면에 늘어놓는 순서 — **가까운 것부터**, '언젠가' 는 맨 뒤 (사용자 요청 2026-11-20) */
export const DUE_KINDS: readonly DueKind[] = ["week", "month", "date", "someday"];
export const DUE_LABELS: Record<DueKind, string> = { week: "이번 주", month: "이번 달", date: "날짜 지정", someday: "언젠가" };

export const isDueKind = (v: unknown): v is DueKind => typeof v === "string" && (DUE_KINDS as readonly string[]).includes(v);

export interface Todo {
  id: number;
  categoryId: number | null;
  title: string;
  memo: string | null;
  dueKind: DueKind;
  /** week·month 면 그 기간의 마지막 날, date 면 고른 날, someday 면 null */
  dueDate: string | null;
  /** 끝낸 시각 (null 이면 아직) */
  doneAt: string | null;
  createdAt: string;
}

export type TodoInput = Pick<Todo, "categoryId" | "title" | "memo" | "dueKind" | "dueDate">;

/** `2026-11-20` → 그 주 토요일. 달력이 일요일 시작이므로 주의 끝은 토요일이다 */
export function weekEnd(today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (6 - d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

/** `2026-11-20` → 그 달 말일 */
export function monthEnd(today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** 고른 기한 → 저장할 날짜 (someday 는 null, date 는 고른 날 그대로) */
export function dueDateFor(kind: DueKind, today: string, picked: string | null): string | null {
  if (kind === "week") return weekEnd(today);
  if (kind === "month") return monthEnd(today);
  if (kind === "date") return picked;
  return null;
}

/** 목록에 보여 줄 기한 한마디 — `언젠가` · `이번 주` · `11월 25일` · `3일 지남` */
export function dueLabel(todo: Pick<Todo, "dueKind" | "dueDate">, today: string): string {
  if (todo.dueKind === "someday" || !todo.dueDate) return DUE_LABELS.someday;
  if (todo.dueDate < today) {
    const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${todo.dueDate}T00:00:00Z`)) / 86_400_000);
    return days === 1 ? "어제까지" : `${days}일 지남`;
  }
  if (todo.dueDate === today) return "오늘";
  if (todo.dueKind === "week") return "이번 주";
  if (todo.dueKind === "month") return "이번 달";
  const [, m, d] = todo.dueDate.split("-") as [string, string, string];
  return `${Number(m)}월 ${Number(d)}일`;
}

/** 기한이 지났나 (someday 는 영영 안 지난다 — 그게 '언젠가' 의 뜻이다) */
export const isOverdue = (todo: Pick<Todo, "dueDate" | "doneAt">, today: string): boolean =>
  !todo.doneAt && !!todo.dueDate && todo.dueDate < today;

/** 기한 없이 오래 묵은 것을 흐리게 보여 줄 기준 (사용자 요청: 쌓이는 게 제일 곤란하다) */
export const STALE_DAYS = 60;
