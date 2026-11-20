/**
 * 동거인(손님)에게 **무엇이 열리고 무엇이 막히는가**.
 *
 * 워커 전체(`createApp`)를 태워서 본다 — 손님을 막는 것은 핸들러가 아니라 길목(`requireSession`)
 * 이라, API 함수만 따로 부르면 정작 중요한 게 검사되지 않는다.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { countReads } from "@homebase/db";
import { createApp } from "./app.ts";
import { counterAt, hotp } from "./totp.ts";

const ORIGIN = "https://homebase.test";
const PASSWORD = "가짜-주인-비밀번호";
const GUEST_ONLY_PASSWORD = "가짜-손님-전용-비밀번호";

let db: SqliteDb;
let app: ReturnType<typeof createApp>;
/** 주인 쿠키와 손님 쿠키를 **따로** 들고 다닌다 — 한 통에 담으면 주인 쿠키로 통과하고도 모른다 */
let jars: { owner: Record<string, string>; guest: Record<string, string> };
/** 손님 전용 비밀번호(Secret)를 따로 넣어 둔 상태인가. 기본은 안 넣음 = 주인 비밀번호를 같이 쓴다 */
let guestOnly = false;

beforeEach(() => {
  db = openMigratedSqlite();
  app = createApp();
  jars = { owner: {}, guest: {} };
  guestOnly = false;
});

type Who = "owner" | "guest" | "nobody";

async function send(
  path: string,
  init: RequestInit & { form?: Record<string, string>; json?: unknown; ip?: string } = {},
  who: Who = "owner",
) {
  const jar = who === "nobody" ? {} : jars[who];
  const headers = new Headers(init.headers);
  headers.set("Cookie", Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "));
  headers.set("CF-Connecting-IP", init.ip ?? "203.0.113.1");
  let body = init.body;
  if (init.form) {
    body = new URLSearchParams(init.form).toString();
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("Content-Type", "application/json");
  }
  if (init.method && init.method !== "GET") headers.set("Origin", headers.get("Origin") ?? ORIGIN);
  const env: Record<string, unknown> = { DB: countReads(db), LOGIN_PASSWORD: PASSWORD };
  if (guestOnly) env.GUEST_PASSWORD = GUEST_ONLY_PASSWORD;
  const res = await app.request(`${ORIGIN}${path}`, { ...init, headers, body }, env);
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const [k, v] = pair!.split("=");
    const target = k === "__Host-hb_guest" ? jars.guest : jars.owner;
    if (/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(c)) delete target[k!];
    else target[k!] = v!;
  }
  return res;
}

/** 주인으로 로그인 (OTP 등록까지) */
async function loginOwner() {
  const page = await (await send("/setup", { method: "POST", form: { password: PASSWORD } })).text();
  const secret = page.match(/<code>([A-Z2-7 ]+)<\/code>/)![1]!.replace(/ /g, "");
  await send("/setup/confirm", { method: "POST", form: { code: await hotp(secret, counterAt(Date.now())) } });
}

const loginGuest = (password = PASSWORD) => send("/guest/login", { method: "POST", form: { password } }, "guest");

/** 주인이 카테고리를 만들고 그 안에 일정 하나를 둔다. 반환: 카테고리 id, 일정 id */
async function makeCategory(name: string, title: string) {
  const cats = (await (await send("/api/calendar/categories", { method: "POST", json: { name, color: "blue" } })).json()) as { id: number }[];
  const cat = cats.find((x) => (x as unknown as { name: string }).name === name)!;
  const ev = (await (
    await send("/api/calendar/events", { method: "POST", json: { categoryId: cat.id, title, startDate: "2026-11-20" } })
  ).json()) as { id: number };
  return { categoryId: cat.id, eventId: ev.id };
}

const share = (...categoryIds: number[]) => send("/api/calendar/guest", { method: "PUT", json: { categoryIds } });

describe("동거인 로그인", () => {
  it("함께 보기를 켜기 전에는 문 자체가 없다", async () => {
    await loginOwner();
    expect((await send("/guest/login", {}, "nobody")).status).toBe(404);
    // 켜면 열린다
    const pet = await makeCategory("반려", "사료 22g");
    await share(pet.categoryId);
    expect((await send("/guest/login", {}, "nobody")).status).toBe(200);
  });

  it("로그인 없이 /guest 를 열면 **그 자리에서** 손님 로그인 화면을 그린다 (되돌려 보내면 루프가 난다)", async () => {
    await loginOwner();
    await share((await makeCategory("반려", "사료 22g")).categoryId);
    const res = await send("/guest", {}, "nobody");
    // 302 로 되돌려 보내면 세션 판정이 한 번만 어긋나도 /guest ↔ /guest/login 을 끝없이 오간다
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/guest/login");
  });

  it("손님 세션 줄이 사라져도 루프가 아니라 로그인 화면이 나온다", async () => {
    await loginOwner();
    await share((await makeCategory("반려", "사료 22g")).categoryId);
    await loginGuest();
    // 쿠키는 있는데 줄만 없는 상태 (운영에서 실제로 이 모양이 됐다)
    db.raw.prepare("DELETE FROM auth_guest_sessions").run();
    const res = await send("/guest", {}, "guest");
    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("비밀번호는 주인 것과 같은 값이다 (따로 정하지 않았을 때)", async () => {
    await loginOwner();
    await share((await makeCategory("반려", "사료 22g")).categoryId);
    expect((await send("/guest/login", { method: "POST", form: { password: "틀린값" } }, "guest")).status).toBe(401);
    const ok = await loginGuest();
    expect(ok.status).toBe(302);
    expect(ok.headers.get("Location")).toBe("/guest");
    expect(jars.guest["__Host-hb_guest"]).toBeTruthy();
  });

  it("손님 비밀번호를 따로 정해 두면 주인 비밀번호로는 못 들어온다", async () => {
    await loginOwner();
    await share((await makeCategory("반려", "사료 22g")).categoryId);
    guestOnly = true;
    expect((await loginGuest(PASSWORD)).status).toBe(401);
    expect((await loginGuest(GUEST_ONLY_PASSWORD)).status).toBe(302);
  });

  it("동거인이 여러 번 틀려도 주인은 막히지 않는다 (집에서는 같은 IP 다)", async () => {
    await loginOwner();
    await share((await makeCategory("반려", "사료 22g")).categoryId);
    for (let i = 0; i < 6; i++) await send("/guest/login", { method: "POST", form: { password: "틀린값" } }, "guest");
    expect((await loginGuest()).status).toBe(429);
    // 주인 쪽 로그인 화면은 그대로 열린다
    expect((await send("/login", {}, "nobody")).status).toBe(200);
  });
});

describe("손님이 갈 수 있는 곳", () => {
  let pet: { categoryId: number; eventId: number };

  beforeEach(async () => {
    await loginOwner();
    pet = await makeCategory("반려", "사료 22g");
    await share(pet.categoryId);
    await loginGuest();
  });

  it("들어온 뒤에 공유를 끄면 그 자리에서 닫힌다 (세션이 남아 있어도)", async () => {
    await share();
    expect((await send("/api/guest/events?from=2026-11-01&to=2026-11-30", {}, "guest")).status).toBe(403);
  });

  it("공유한 카테고리 일정만 보인다", async () => {
    await makeCategory("가계", "월세 내는 날");

    const res = await send("/api/guest/events?from=2026-11-01&to=2026-11-30", {}, "guest");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { id: number; title: string }[]; categories: { name: string }[] };
    expect(body.categories.map((x) => x.name)).toEqual(["반려"]);
    expect(body.events.map((e) => e.title)).toEqual(["사료 22g"]);
  });

  it("가계부·일정 주인 API·데이터 버전은 손님에게 전부 막힌다", async () => {
    for (const path of ["/api/ledger/transactions?from=2026-11-01&to=2026-11-30", "/api/calendar/events?from=2026-11-01&to=2026-11-30", "/api/rev", "/api/session", "/api/photos?app=ledger&ref=1"]) {
      const res = await send(path, {}, "guest");
      expect([401, 404], `${path} 가 열렸다`).toContain(res.status);
    }
  });

  it("손님이 주인 화면을 열면 제 화면으로 돌려보낸다", async () => {
    const res = await send("/", {}, "guest");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/guest");
  });
});

describe("손님이 쓰는 일정", () => {
  let pet: { categoryId: number; eventId: number };
  let other: { categoryId: number; eventId: number };

  beforeEach(async () => {
    await loginOwner();
    pet = await makeCategory("반려", "사료 22g");
    other = await makeCategory("가계", "월세 내는 날");
    await share(pet.categoryId);
    await loginGuest();
  });

  it("새 일정에 공유 밖 카테고리를 보내면 공유 카테고리로 떨어진다", async () => {
    const res = await send("/api/guest/events", { method: "POST", json: { categoryId: other.categoryId, title: "산책", startDate: "2026-11-21" } }, "guest");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { categoryId: number }).categoryId).toBe(pet.categoryId);
  });

  it("고칠 때도 공유 밖 카테고리로는 못 옮긴다", async () => {
    const res = await send(
      `/api/guest/events/${pet.eventId}`,
      { method: "PUT", json: { categoryId: other.categoryId, title: "사료 22g", startDate: "2026-11-20" } },
      "guest",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { categoryId: number }).categoryId).toBe(pet.categoryId);
  });

  it("남의 카테고리 일정은 고치지도 지우지도 못한다", async () => {
    const put = await send(`/api/guest/events/${other.eventId}`, { method: "PUT", json: { title: "바꿔치기", startDate: "2026-11-20" } }, "guest");
    expect(put.status).toBe(404);
    expect((await send(`/api/guest/events/${other.eventId}`, { method: "DELETE" }, "guest")).status).toBe(404);
    // 원래 일정은 그대로다
    const row = db.raw.prepare("SELECT title FROM calendar_events WHERE id = ?").get(other.eventId) as { title: string };
    expect(row.title).toBe("월세 내는 날");
  });

  it("공유 카테고리 일정은 고치고 지울 수 있다", async () => {
    const put = await send(`/api/guest/events/${pet.eventId}`, { method: "PUT", json: { title: "밥 25g", startDate: "2026-11-20" } }, "guest");
    expect(put.status).toBe(200);
    expect((await send(`/api/guest/events/${pet.eventId}`, { method: "DELETE" }, "guest")).status).toBe(200);
  });

  it("주인이 공유를 끄면 그 자리에서 닫힌다", async () => {
    await share();
    expect((await send("/api/guest/events?from=2026-11-01&to=2026-11-30", {}, "guest")).status).toBe(403);
  });

  it("공유하던 카테고리를 지우면 공유도 같이 닫힌다 (지운 번호를 새 카테고리가 물려받는다)", async () => {
    await send(`/api/calendar/categories/${pet.categoryId}`, { method: "DELETE" });
    const meta = db.raw.prepare("SELECT value FROM app_meta WHERE key = 'calendar.guest_category'").get();
    expect(meta).toBeUndefined();
    expect((await send("/api/guest/events?from=2026-11-01&to=2026-11-30", {}, "guest")).status).toBe(403);
  });
});

describe("손님과 사진", () => {
  it("남의 일정에는 붙이지도 보지도 못한다", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    const other = await makeCategory("가계", "월세 내는 날");
    await share(pet.categoryId);
    await loginGuest();

    // 남의 일정 사진 목록은 빈 값 (있는지 없는지도 알려 주지 않는다)
    const list = await send(`/api/guest/photos?ref=${other.eventId}`, {}, "guest");
    expect(((await list.json()) as { photos: unknown[] }).photos).toEqual([]);

    const form = new FormData();
    form.set("ref", String(other.eventId));
    form.set("full", new File([new Uint8Array([0xff, 0xd8, 0xff, 0])], "a.jpg", { type: "image/jpeg" }));
    form.set("thumb", new File([new Uint8Array([0xff, 0xd8, 0xff, 0])], "t.jpg", { type: "image/jpeg" }));
    const up = await send("/api/guest/photos", { method: "POST", body: form }, "guest");
    expect([404, 503]).toContain(up.status); // KV 가 없으면 503, 있으면 404 (어느 쪽이든 안 붙는다)
  });
});

describe("여러 카테고리를 함께 보기", () => {
  it("켠 카테고리들만 보이고, 그 안에서는 분류를 골라 적을 수 있다", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    const trip = await makeCategory("공유 일정", "주말 나들이");
    await makeCategory("가계", "월세 내는 날");
    await share(pet.categoryId, trip.categoryId);
    await loginGuest();

    const body = (await (await send("/api/guest/events?from=2026-11-01&to=2026-11-30", {}, "guest")).json()) as {
      events: { title: string }[];
      categories: { name: string }[];
    };
    expect(body.categories.map((x) => x.name).sort()).toEqual(["공유 일정", "반려"]);
    expect(body.events.map((e) => e.title).sort()).toEqual(["사료 22g", "주말 나들이"]);

    // 둘 중 하나를 골라 적을 수 있다
    const made = await send("/api/guest/events", { method: "POST", json: { categoryId: trip.categoryId, title: "산책", startDate: "2026-11-21" } }, "guest");
    expect(((await made.json()) as { categoryId: number }).categoryId).toBe(trip.categoryId);
  });

  it("하나를 끄면 그 카테고리 일정은 바로 안 보인다", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    const trip = await makeCategory("공유 일정", "주말 나들이");
    await share(pet.categoryId, trip.categoryId);
    await loginGuest();
    await share(pet.categoryId);

    const body = (await (await send("/api/guest/events?from=2026-11-01&to=2026-11-30", {}, "guest")).json()) as { events: { title: string }[] };
    expect(body.events.map((e) => e.title)).toEqual(["사료 22g"]);
  });

  it("없는 카테고리를 끼워 넣으면 거절한다 (지운 번호를 새 카테고리가 물려받는다)", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    expect((await share(pet.categoryId, 9999)).status).toBe(404);
  });
});

describe("할 일", () => {
  /** 카테고리 하나를 만들고 그 안에 할 일 하나를 둔다 */
  async function makeTodo(categoryId: number, title: string, body: Record<string, unknown> = {}) {
    const res = await send("/api/calendar/todos", { method: "POST", json: { categoryId, title, ...body } });
    return (await res.json()) as { id: number; dueKind: string; dueDate: string | null; doneAt: string | null };
  }

  it("동거인은 **함께 보기를 켠 카테고리의 할 일만** 본다", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    const mine = await makeCategory("내 일정", "회의");
    await makeTodo(pet.categoryId, "사료 주문");
    await makeTodo(mine.categoryId, "연말정산 서류");
    await share(pet.categoryId);
    await loginGuest();

    const list = (await (await send("/api/guest/todos", {}, "guest")).json()) as { open: { title: string }[] };
    expect(list.open.map((t) => t.title)).toEqual(["사료 주문"]);
  });

  it("남의 카테고리 할 일은 번호를 알아도 못 고치고 못 지운다", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    const mine = await makeCategory("내 일정", "회의");
    const secret = await makeTodo(mine.categoryId, "연말정산 서류");
    await share(pet.categoryId);
    await loginGuest();

    expect((await send(`/api/guest/todos/${secret.id}`, { method: "PUT", json: { title: "바꿔치기" } }, "guest")).status).toBe(404);
    expect((await send(`/api/guest/todos/${secret.id}/done`, { method: "POST", json: { done: true } }, "guest")).status).toBe(404);
    expect((await send(`/api/guest/todos/${secret.id}`, { method: "DELETE" }, "guest")).status).toBe(404);
    // 주인 쪽에서 그대로인지 확인
    const after = (await (await send("/api/calendar/todos")).json()) as { open: { title: string; doneAt: string | null }[] };
    expect(after.open.find((t) => t.title === "연말정산 서류")?.doneAt).toBeNull();
  });

  it("동거인이 적은 할 일은 공유 카테고리로 떨어진다 (다른 번호를 보내도)", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    const mine = await makeCategory("내 일정", "회의");
    await share(pet.categoryId);
    await loginGuest();

    const made = (await (
      await send("/api/guest/todos", { method: "POST", json: { categoryId: mine.categoryId, title: "모래 사기" } }, "guest")
    ).json()) as { categoryId: number };
    expect(made.categoryId).toBe(pet.categoryId);
  });

  it("체크하면 지워지지 않고 '끝낸 것' 으로 간다. 되돌릴 수도 있다", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    const todo = await makeTodo(pet.categoryId, "사료 주문");

    type Lists = { open: { id: number }[]; done: { id: number }[] };
    await send(`/api/calendar/todos/${todo.id}/done`, { method: "POST", json: { done: true } });
    const after = (await (await send("/api/calendar/todos")).json()) as Lists;
    expect(after.open).toHaveLength(0);
    expect(after.done.map((t) => t.id)).toEqual([todo.id]);

    await send(`/api/calendar/todos/${todo.id}/done`, { method: "POST", json: { done: false } });
    const back = (await (await send("/api/calendar/todos")).json()) as Lists;
    expect(back.open.map((t) => t.id)).toEqual([todo.id]);
    expect(back.done).toHaveLength(0);
  });

  it("'이번 주'·'이번 달' 은 그 기간의 마지막 날로 저장된다 (다음 주가 되면 제대로 지난 것이 된다)", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    const week = await makeTodo(pet.categoryId, "이번 주 것", { dueKind: "week" });
    const month = await makeTodo(pet.categoryId, "이번 달 것", { dueKind: "month" });
    const someday = await makeTodo(pet.categoryId, "언젠가 것", { dueKind: "someday" });

    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    expect(week.dueDate).not.toBeNull();
    expect(week.dueDate! >= today).toBe(true);
    expect(month.dueDate! >= week.dueDate!).toBe(true);
    expect(someday.dueDate).toBeNull();
  });

  it("보낸 날짜를 그대로 믿지 않는다 — 기한 종류에서 다시 계산한다", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    // '이번 주' 라면서 2년 뒤 날짜를 보내도 저장되는 건 이번 주 토요일이다
    const t = await makeTodo(pet.categoryId, "속이기", { dueKind: "week", dueDate: "2028-12-31" });
    expect(t.dueDate).not.toBe("2028-12-31");
  });

  it("손님은 할 일 사진도 공유 카테고리 것만 본다", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    const mine = await makeCategory("내 일정", "회의");
    const ours = await makeTodo(pet.categoryId, "사료 주문");
    const secret = await makeTodo(mine.categoryId, "연말정산 서류");
    await share(pet.categoryId);
    await loginGuest();

    expect((await (await send(`/api/guest/photos?app=todo&ref=${ours.id}`, {}, "guest")).json())).toHaveProperty("photos");
    const hidden = (await (await send(`/api/guest/photos?app=todo&ref=${secret.id}`, {}, "guest")).json()) as { photos: unknown[] };
    expect(hidden.photos).toHaveLength(0);
  });

  it("공유를 끄면 할 일도 함께 닫힌다", async () => {
    await loginOwner();
    const pet = await makeCategory("반려", "사료 22g");
    await makeTodo(pet.categoryId, "사료 주문");
    await share(pet.categoryId);
    await loginGuest();
    expect((await send("/api/guest/todos", {}, "guest")).status).toBe(200);

    await share(); // 전부 끄기
    expect((await send("/api/guest/todos", {}, "guest")).status).toBe(403);
  });
});
