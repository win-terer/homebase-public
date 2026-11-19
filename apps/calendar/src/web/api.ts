import { cacheGet, cacheSet, clearWebCache, primeRev } from "@homebase/core/web-cache";
import type { CalendarEvent } from "../shared/occurrences.ts";

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

export type EventInput = Omit<CalendarEvent, "id" | "skipDates">;

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
  if (isRead) {
    await primeRev();
    const hit = cacheGet(url);
    if (hit !== undefined) return hit as T;
  }
  const res = await fetch(url, init);
  if (res.status === 401) {
    clearWebCache();
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new Error("로그인이 필요해요");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  if (isRead) cacheSet(url, data);
  // 뭔가 바꿨으면 서버 버전이 오른다 — 들고 있던 건 전부 버리고 새 버전을 미리 물어본다
  else {
    clearWebCache();
    void primeRev();
  }
  return data;
}

const send = <T>(url: string, method: string, body?: unknown) =>
  request<T>(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export const calendarApi = {
  events: (from: string, to: string) =>
    request<{ events: CalendarEvent[]; categories: Category[] }>(`/api/calendar/events?from=${from}&to=${to}`),
  create: (e: EventInput) => send<CalendarEvent>("/api/calendar/events", "POST", e),
  update: (id: number, e: EventInput) => send<CalendarEvent>(`/api/calendar/events/${id}`, "PUT", e),
  remove: (id: number) => send<{ ok: true }>(`/api/calendar/events/${id}`, "DELETE"),
  /** 반복 일정의 한 회차만 빼기(event 없음) 또는 그 회차만 바꾸기 */
  occurrence: (id: number, date: string, event?: EventInput) => send<{ ok: true }>(`/api/calendar/events/${id}/occurrence`, "POST", { date, event }),
  /** 제목·장소·메모·카테고리 이름에서 찾기. 반복 일정은 보여 줄 날짜를 서버가 정해 준다 */
  search: (q: string) =>
    request<{ results: { event: CalendarEvent; date: string }[]; more: boolean; categories: Category[] }>(`/api/calendar/search?q=${encodeURIComponent(q)}`),
  importedUids: () => request<string[]>("/api/calendar/import/uids"),
  importEvents: (categories: { name: string; color: string }[], events: unknown[]) =>
    send<{ inserted: number; duplicates: number; categories: Category[] }>("/api/calendar/import", "POST", { categories, events }),
  notesPreview: (items: NoteItem[]) =>
    send<{ matched: number; already: number; unmatched: number; samples: { date: string; amount: number; merchant: string; note: string }[] }>("/api/ledger/notes/preview", "POST", { items }),
  notesApply: (items: NoteItem[]) => send<{ applied: number }>("/api/ledger/notes/apply", "POST", { items }),
  addCategory: (name: string, color: string) => send<Category[]>("/api/calendar/categories", "POST", { name, color }),
  updateCategory: (id: number, change: Partial<Pick<Category, "name" | "color" | "hidden">>) =>
    send<Category[]>(`/api/calendar/categories/${id}`, "PATCH", change),
  removeCategory: (id: number) => send<Category[]>(`/api/calendar/categories/${id}`, "DELETE"),
};

export const COLOR_LABELS: Record<string, string> = {
  blue: "파랑",
  green: "초록",
  red: "빨강",
  orange: "주황",
  purple: "보라",
  teal: "청록",
  gray: "회색",
};
