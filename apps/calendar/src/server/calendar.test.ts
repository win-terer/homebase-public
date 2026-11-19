import { describe, expect, it } from "vitest";
import { openMigratedSqlite } from "@homebase/db/sqlite";
import { calendarServer } from "./index.ts";

function setup() {
  const db = openMigratedSqlite();
  const api = calendarServer.createApi();
  const req = async (path: string, method = "GET", body?: unknown) => {
    const r = await api.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, { DB: db });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { db, req };
}

describe("calendar API", () => {
  it("searches title, location, memo and category name", async () => {
    const { req } = setup();
    await req("/events", "POST", { title: "치과 정기검진", startDate: "2026-10-05", startTime: "19:00", location: "가짜치과", categoryId: 1 });
    await req("/events", "POST", { title: "저녁 약속", startDate: "2026-10-06", memo: "가짜치과 근처 식당", categoryId: 2 });
    await req("/events", "POST", { title: "상관없는 것", startDate: "2026-10-07" });

    // 제목·장소·메모 어디서든 찾는다
    const hits = await req("/search?q=" + encodeURIComponent("가짜치과"));
    expect(hits.body.results.map((r: { event: { title: string } }) => r.event.title).sort()).toEqual(["저녁 약속", "치과 정기검진"]);
    // 카테고리 이름으로도
    expect((await req("/search?q=" + encodeURIComponent("약속"))).body.results.map((r: { event: { title: string } }) => r.event.title)).toEqual(["저녁 약속"]);
    // 띄어쓰기는 AND — 둘 다 맞아야 한다
    expect((await req("/search?q=" + encodeURIComponent("가짜치과 정기검진"))).body.results).toHaveLength(1);
    expect((await req("/search?q=" + encodeURIComponent("가짜치과 없는말"))).body.results).toEqual([]);
    expect((await req("/search?q=")).body.results).toEqual([]);
  });

  it("반복 일정은 오늘 기준 다음 회차를 보여 준다", async () => {
    const { req } = setup();
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const past = new Date(Date.now() + 9 * 3_600_000 - 70 * 86_400_000).toISOString().slice(0, 10);
    // 열 주 전에 시작한 매주 일정 — 시작일이 아니라 앞으로 올 날짜가 나와야 쓸모가 있다
    await req("/events", "POST", { title: "가짜 주간회의", startDate: past, startTime: "10:00", repeat: "weekly" });
    const hit = (await req("/search?q=" + encodeURIComponent("가짜 주간회의"))).body.results[0];
    expect(hit.date >= today).toBe(true);
    expect(hit.event.startDate).toBe(past); // 원본은 그대로

    // 이미 끝난 반복은 마지막 회차를 보여 준다
    const ended = new Date(Date.now() + 9 * 3_600_000 - 30 * 86_400_000).toISOString().slice(0, 10);
    await req("/events", "POST", { title: "가짜 끝난모임", startDate: past, startTime: "10:00", repeat: "weekly", repeatUntil: ended });
    const done = (await req("/search?q=" + encodeURIComponent("가짜 끝난모임"))).body.results[0];
    expect(done.date <= ended).toBe(true);
    expect(done.date > past).toBe(true);
  });

  it("creates, lists by range, updates and deletes events", async () => {
    const { req } = setup();
    const created = await req("/events", "POST", { title: "가짜 약속", startDate: "2026-10-05", startTime: "19:00", endTime: "21:00", location: "가짜 식당", categoryId: 2 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: "가짜 약속", endDate: "2026-10-05", startTime: "19:00", location: "가짜 식당", repeat: null, skipDates: [] });
    await req("/events", "POST", { title: "지난달", startDate: "2026-08-01" });
    const list = await req("/events?from=2026-09-27&to=2026-11-07");
    expect(list.body.events.map((e: { title: string }) => e.title)).toEqual(["가짜 약속"]);
    expect(list.body.categories.map((c: { name: string }) => c.name)).toEqual(["일정", "약속"]);

    const id = created.body.id;
    const updated = await req(`/events/${id}`, "PUT", { ...created.body, title: "가짜 저녁" });
    expect(updated.body.title).toBe("가짜 저녁");
    await req(`/events/${id}`, "DELETE");
    expect((await req("/events?from=2026-09-27&to=2026-11-07")).body.events).toEqual([]);
  });

  it("finds a multi-day event that started before the range, and repeats from long ago", async () => {
    const { req } = setup();
    await req("/events", "POST", { title: "가짜 여행", startDate: "2026-09-28", endDate: "2026-10-03" });
    await req("/events", "POST", { title: "가짜 월례", startDate: "2024-01-25", repeat: "monthly" });
    await req("/events", "POST", { title: "끝난 반복", startDate: "2024-01-01", repeat: "weekly", repeatUntil: "2024-06-30" });
    const list = await req("/events?from=2026-10-01&to=2026-10-31");
    expect(list.body.events.map((e: { title: string }) => e.title).sort()).toEqual(["가짜 여행", "가짜 월례"]);
  });

  it("skips or replaces one occurrence of a repeating event", async () => {
    const { req } = setup();
    const { body: weekly } = await req("/events", "POST", { title: "가짜 운동", startDate: "2026-10-05", startTime: "07:00", repeat: "weekly" });
    await req(`/events/${weekly.id}/occurrence`, "POST", { date: "2026-10-12" });
    await req(`/events/${weekly.id}/occurrence`, "POST", { date: "2026-10-19", event: { ...weekly, startDate: "2026-10-20", endDate: "2026-10-20", startTime: "08:00" } });
    const { body } = await req("/events?from=2026-10-01&to=2026-10-31");
    const base = body.events.find((e: { repeat: string | null }) => e.repeat === "weekly");
    expect(base.skipDates).toEqual(["2026-10-12", "2026-10-19"]);
    expect(body.events.find((e: { repeat: string | null }) => e.repeat === null)).toMatchObject({ title: "가짜 운동", startDate: "2026-10-20", startTime: "08:00" });
  });

  it("gives other apps the expanded days without hidden categories", async () => {
    const { req } = setup();
    await req("/events", "POST", { title: "가짜 운동", startDate: "2026-10-05", startTime: "07:00", endTime: "08:00", repeat: "weekly", categoryId: 1 });
    await req("/events", "POST", { title: "가짜 약속", startDate: "2026-10-06", categoryId: 2, location: "가짜 카페" });
    await req("/categories/2", "PATCH", { hidden: true });
    const { body } = await req("/days?from=2026-10-01&to=2026-10-14");
    expect(Object.keys(body.days).sort()).toEqual(["2026-10-05", "2026-10-12"]);
    expect(body.days["2026-10-05"][0]).toMatchObject({ title: "가짜 운동", time: "07:00–08:00", color: "blue" });
  });

  it("imports events with categories by name and skips ones already imported", async () => {
    const { req } = setup();
    const events = [
      { sourceUid: "u1", category: "가짜 문화", title: "가짜 공연", startDate: "2026-10-10", startTime: "19:30", endTime: "21:30", location: "가짜 극장", memo: "R석" },
      { sourceUid: "u2", category: "일정", title: "가짜 생일", startDate: "2020-03-09", repeat: "yearly" },
      { sourceUid: "u3", category: "가짜 문화", title: "가짜 정기", startDate: "2026-01-15", repeat: "monthly", repeatUntil: "2026-12-15", skipDates: ["2026-03-15"] },
    ];
    const first = await req("/import", "POST", { categories: [{ name: "가짜 문화", color: "purple" }, { name: "일정", color: "red" }], events });
    expect(first.body).toMatchObject({ inserted: 3, duplicates: 0 });
    expect(first.body.categories.find((c: { name: string }) => c.name === "가짜 문화")).toMatchObject({ color: "purple" });
    // 이미 있는 '일정' 카테고리는 색을 바꾸지 않는다
    expect(first.body.categories.find((c: { name: string }) => c.name === "일정")).toMatchObject({ color: "blue" });
    const again = await req("/import", "POST", { categories: [], events });
    expect(again.body).toMatchObject({ inserted: 0, duplicates: 3 });
    expect((await req("/import/uids")).body.sort()).toEqual(["u1", "u2", "u3"]);
    const { body } = await req("/events?from=2026-03-01&to=2026-03-31");
    expect(body.events.map((e: { title: string; skipDates: string[] }) => [e.title, e.skipDates])).toEqual(expect.arrayContaining([["가짜 생일", []], ["가짜 정기", ["2026-03-15"]]]));
  });

  it("rejects bad input", async () => {
    const { req } = setup();
    expect((await req("/events", "POST", { title: "", startDate: "2026-10-05" })).status).toBe(400);
    expect((await req("/events", "POST", { title: "x", startDate: "2026-10-05", endDate: "2026-10-04" })).status).toBe(400);
    expect((await req("/events", "POST", { title: "x", startDate: "2026-10-05", endDate: "2027-01-05" })).status).toBe(400);
    expect((await req("/events", "POST", { title: "x", startDate: "2026-10-05", startTime: "25:00" })).status).toBe(400);
    expect((await req("/events?from=2026-10-31&to=2026-10-01")).status).toBe(400);
  });

  it("manages categories; deleting one keeps its events without a category", async () => {
    const { req } = setup();
    const added = await req("/categories", "POST", { name: "가짜 병원", color: "red" });
    const cat = added.body.find((c: { name: string }) => c.name === "가짜 병원");
    await req("/events", "POST", { title: "가짜 진료", startDate: "2026-10-07", categoryId: cat.id });
    const hidden = await req(`/categories/${cat.id}`, "PATCH", { hidden: true, color: "purple" });
    expect(hidden.body.find((c: { id: number }) => c.id === cat.id)).toMatchObject({ hidden: true, color: "purple" });
    await req(`/categories/${cat.id}`, "DELETE");
    const { body } = await req("/events?from=2026-10-01&to=2026-10-31");
    expect(body.events[0]).toMatchObject({ title: "가짜 진료", categoryId: null });
    expect(body.categories.map((c: { name: string }) => c.name)).toEqual(["일정", "약속"]);
  });
});
