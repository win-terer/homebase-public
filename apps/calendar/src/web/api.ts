import { cacheGet, cacheSet, clearWebCache, primeRev } from "@homebase/core/web-cache";
import type { Names, Seen } from "@homebase/core/presence";
import type { CalendarEvent } from "../shared/occurrences.ts";
import type { Todo, TodoInput } from "../shared/todos.ts";

export interface Category {
  id: number;
  name: string;
  color: string;
  hidden: boolean;
  sort: number;
}

/** 가계부로 보낼 예전 지출 기록의 상세 메모 */
export interface NoteItem {
  date: string;
  amount: number;
  title: string;
  note: string;
}

export type EventInput = Omit<CalendarEvent, "id" | "skipDates" | "createdAt">;

/**
 * 손님(동거인) 모드 — **화면은 주인 것과 같고 길만 다르다**(`/api/guest/…`).
 *
 * 주인 달력을 그대로 쓰는 게 요점이다. 따로 만들었더니 같은 화면을 두 번 만드는 꼴이 됐고
 * 품질도 뒤처졌다(2026-11-19). 서버 쪽 손님 길은 공유 카테고리를 쿼리에 박아 두므로
 * (apps/calendar/src/server/guest.ts), 화면이 실수로 다른 걸 불러도 401·404 로 막힌다.
 *
 * `guest.tsx` 가 그리기 전에 한 번 켠다.
 */
let BASE = "/api/calendar";
let GUEST = false;
export const useGuestRoutes = () => {
  BASE = "/api/guest";
  GUEST = true;
};
export const isGuestMode = () => GUEST;

/**
 * 조회는 들고 있던 걸 먼저 본다 — 가계부(`ledger/web/api.ts`)와 같은 방식.
 *
 * 한국에서 접속해도 LA 거점으로 붙어 왕복 한 번이 150~700ms 다. 일정 화면도 달을 앞뒤로
 * 넘길 때마다 같은 달을 다시 묻는데, 바뀐 게 없으면 서버가 304 로 끝내 주더라도 **304 도
 * 왕복은 왕복**이다. 데이터 버전 하나만 확인하고 나머지는 네트워크를 건너뛴다.
 * (2026-10-06 추가 — 그전까지 일정만 이 캐시를 안 타고 있었다.)
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const isRead = !init?.method || init.method === "GET";
  // 손님은 데이터 버전(`/api/rev`)을 볼 수 없다 — 그 캐시는 건너뛴다. 받아 오는 양이 작아 괜찮다
  if (isRead && !GUEST) {
    await primeRev();
    const hit = cacheGet(url);
    if (hit !== undefined) return hit as T;
  }
  const res = await fetch(url, init);
  if (res.status === 401) {
    clearWebCache();
    window.location.assign(GUEST ? "/guest/login" : `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new Error("로그인이 필요해요");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  if (isRead) {
    if (!GUEST) cacheSet(url, data);
  }
  // 뭔가 바꿨으면 서버 버전이 오른다 — 들고 있던 건 전부 버리고 새 버전을 미리 물어본다
  else if (!GUEST) {
    clearWebCache();
    void primeRev();
  }
  return data;
}

/**
 * "나 여기 있어" — **`request()` 를 타지 않는다.**
 *
 * 그쪽은 GET 이 아닌 요청이 끝나면 "뭔가 바뀌었다" 고 보고 들고 있던 응답을 전부 버린다.
 * 접속 표시는 1분마다 가므로 그 길로 보내면 **1분마다 캐시가 통째로 깨진다** — 느려지지
 * 않으려고 만든 3층 캐시가 그대로 무너진다. 여기서는 아무것도 비우지 않는다.
 */
async function presence(): Promise<{ seen: Seen[]; rev: string; names: Names }> {
  const res = await fetch(`${BASE}/presence`, { method: "POST", headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`접속 표시 실패 (${res.status})`);
  return (await res.json()) as { seen: Seen[]; rev: string; names: Names };
}

const send = <T>(url: string, method: string, body?: unknown) =>
  request<T>(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** 모아 보기 한 장 */
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

/** 동거인과 함께 보는 카테고리 (목록이 비어 있으면 공유를 안 하는 중) */
export interface SharedCategory {
  id: number;
  name: string;
  color: string;
}

/**
 * 들고 있던 응답을 버린다 — **상대가 뭔가 바꿨을 때** 쓴다 (접속 확인이 알려 준다).
 * 데이터 버전은 화면이 뜰 때 한 번만 물어보므로, 비워 주지 않으면 옛 응답을 계속 쓴다.
 */
export const forgetCached = () => clearWebCache();

export const calendarApi = {
  events: (from: string, to: string) =>
    request<{ events: CalendarEvent[]; categories: Category[]; todos?: DayTodo[] }>(`${BASE}/events?from=${from}&to=${to}`),
  create: (e: EventInput) => send<CalendarEvent>(`${BASE}/events`, "POST", e),
  /**
   * 그 기간 일정에 붙은 사진 (모아 보기). 손님 길은 이름이 다르다 — 거기선 `/photos` 가
   * 이미 '한 일정의 사진 목록' 이다.
   */
  monthPhotos: (from: string, to: string) =>
    request<{ photos: MonthPhoto[] }>(`${BASE}${isGuestMode() ? "/photos/month" : "/photos"}?from=${from}&to=${to}`),
  /**
   * "나 여기 있어" 를 남기고 둘의 상태를 받는다 (1분마다).
   * 실시간은 WebSocket(Durable Objects)이 필요한데 유료라, **최대 1분 늦은 상태**를 보여 준다.
   */
  presence: presence,
  /** 서로를 뭐라고 부를지 정한다 (접속 표시에 쓴다) */
  setNames: (names: { owner?: string; guest?: string }) => send<{ names: Names }>("/api/calendar/names", "PUT", names),
  /** 지금 함께 보는 카테고리들 */
  guest: () => request<{ categories: SharedCategory[]; names: Names }>("/api/calendar/guest"),
  /** 함께 볼 카테고리들을 정한다. 빈 배열이면 공유를 닫는다 */
  setGuest: (categoryIds: number[]) => send<{ categories: SharedCategory[] }>("/api/calendar/guest", "PUT", { categoryIds }),
  update: (id: number, e: EventInput) => send<CalendarEvent>(`${BASE}/events/${id}`, "PUT", e),
  remove: (id: number) => send<{ ok: true }>(`${BASE}/events/${id}`, "DELETE"),
  /** 반복 일정의 한 회차만 빼기(event 없음) 또는 그 회차만 바꾸기 */
  occurrence: (id: number, date: string, event?: EventInput) => send<{ ok: true }>(`${BASE}/events/${id}/occurrence`, "POST", { date, event }),
  /** 제목·장소·메모·카테고리 이름에서 찾기. 반복 일정은 보여 줄 날짜를 서버가 정해 준다 */
  search: (q: string) =>
    request<{ results: { event: CalendarEvent; date: string }[]; more: boolean; categories: Category[] }>(`/api/calendar/search?q=${encodeURIComponent(q)}`),
  importedUids: () => request<string[]>("/api/calendar/import/uids"),
  importEvents: (categories: { name: string; color: string }[], events: unknown[]) =>
    send<{ inserted: number; duplicates: number; categories: Category[] }>("/api/calendar/import", "POST", { categories, events }),
  notesPreview: (items: NoteItem[]) =>
    send<{ matched: number; already: number; unmatched: number; samples: { date: string; amount: number; merchant: string; note: string }[] }>("/api/ledger/notes/preview", "POST", { items }),
  notesApply: (items: NoteItem[]) => send<{ applied: number }>("/api/ledger/notes/apply", "POST", { items }),
  /* ── 할 일 ── 일정과 같은 카테고리를 쓴다. 손님 길도 이름이 같다 */
  todos: () => request<TodoList>(`${BASE}/todos`),
  addTodo: (t: TodoInput) => send<Todo>(`${BASE}/todos`, "POST", t),
  updateTodo: (id: number, t: TodoInput) => send<Todo>(`${BASE}/todos/${id}`, "PUT", t),
  /** 체크 / 체크 풀기 — 지우지 않고 '끝낸 것' 으로 내린다 */
  setTodoDone: (id: number, done: boolean) => send<Todo>(`${BASE}/todos/${id}/done`, "POST", { done }),
  removeTodo: (id: number) => send<{ ok: true }>(`${BASE}/todos/${id}`, "DELETE"),
  addCategory: (name: string, color: string) => send<Category[]>("/api/calendar/categories", "POST", { name, color }),
  updateCategory: (id: number, change: Partial<Pick<Category, "name" | "color" | "hidden">>) =>
    send<Category[]>(`/api/calendar/categories/${id}`, "PATCH", change),
  removeCategory: (id: number) => send<Category[]>(`/api/calendar/categories/${id}`, "DELETE"),
};

/** 달력 칸에 한 줄로 그릴 할 일 (날짜를 콕 집어 둔 것만 온다) */
export interface DayTodo {
  id: number;
  title: string;
  dueDate: string;
  categoryId: number | null;
}

export interface TodoList {
  open: Todo[];
  done: Todo[];
  categories: Category[];
  /** 끝낸 것을 몇 개까지 내려보냈나 (그만큼만 보여 준다고 화면이 말해 줄 때 쓴다) */
  doneLimit: number;
  /** 서버가 보는 오늘 (Asia/Seoul) — 기한 '지남' 을 브라우저 시계로 재지 않게 */
  today: string;
}

export const COLOR_LABELS: Record<string, string> = {
  blue: "파랑",
  green: "초록",
  red: "빨강",
  orange: "주황",
  purple: "보라",
  teal: "청록",
  gray: "회색",
};
