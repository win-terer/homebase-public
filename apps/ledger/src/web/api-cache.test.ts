import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 화면이 실제로 쓰는 `ledgerApi` 가 왕복을 몇 번 하는지 센다.
 *
 * 이 사이트는 한국에서도 LA 거점으로 붙어 왕복 한 번이 150~700ms 다(shared/core/src/web-cache.ts).
 * 그래서 '몇 번 도느냐' 가 곧 체감 속도다 — 그 수를 고정해 둔다.
 */

function browser() {
  const box = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => void box.set(k, v),
    removeItem: (k: string) => void box.delete(k),
  });
  const calls: string[] = [];
  let rev = 1;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/rev") return Promise.resolve({ ok: true, json: () => Promise.resolve({ rev: `${rev}.2026-10-02` }) });
    if (init?.method && init.method !== "GET") rev += 1; // 쓰기는 서버 버전을 올린다
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ id: 1 }]) });
  });
  return { calls, bumped: () => rev };
}

async function load() {
  vi.resetModules();
  return (await import("./api.ts")).ledgerApi;
}

/** 달력 한 번 열 때 화면이 부르는 것들 */
const openCalendar = (api: Awaited<ReturnType<typeof load>>) =>
  Promise.all([api.overview(), api.categories(), api.recurring(), api.transactions("2026-10-01", "2026-10-31"), api.schedule("2026-10-01", "2026-10-31")]);

describe("달력을 열 때 도는 왕복 횟수", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("처음 열면 버전 한 번 + 조회 다섯 번", async () => {
    const { calls } = browser();
    const api = await load();
    await openCalendar(api);
    expect(calls.filter((c) => c.includes("/api/rev"))).toHaveLength(1);
    expect(calls).toHaveLength(6);
  });

  it("다시 열면 버전만 확인하고 끝 — 데이터는 한 번도 안 받는다", async () => {
    const { calls } = browser();
    const api = await load();
    await openCalendar(api);
    calls.length = 0;

    // 같은 화면을 다시 (같은 세션 안에서 탭을 오갈 때)
    await openCalendar(api);
    expect(calls).toHaveLength(0);
  });

  it("브라우저를 닫았다 다시 와도 버전 한 번이면 된다", async () => {
    const { calls } = browser();
    await openCalendar(await load());

    // 같은 localStorage 를 그대로 두고 모듈만 새로 올린다 = 새 방문
    calls.length = 0;
    const again = await load();
    await openCalendar(again);
    expect(calls).toEqual(["GET /api/rev"]);
  });

  it("뭔가 고치면 들고 있던 걸 버리고 다시 받는다", async () => {
    const { calls } = browser();
    const api = await load();
    await openCalendar(api);

    await api.setMemo(1, { memo: "바뀜" });
    calls.length = 0;
    await openCalendar(api);
    // 버전 하나 + 다섯 조회 = 옛 답을 그대로 쓰지 않는다
    expect(calls.filter((c) => !c.includes("/api/rev"))).toHaveLength(5);
  });
});

describe("알림 화면은 캐시를 안 거친다", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("버전이 그대로여도 매번 서버에 묻고, 들고 있던 다른 조회는 건드리지 않는다", async () => {
    const { calls } = browser();
    const api = await load();
    await openCalendar(api);
    calls.length = 0;

    await api.notifyOverview();
    await api.notifyOverview();
    // 자동 가져오기 보고는 데이터 버전을 안 올리므로 버전만 봐서는 바뀐 걸 모른다
    expect(calls).toEqual(["GET /api/ledger/notify/overview", "GET /api/ledger/notify/overview"]);
    calls.length = 0;

    // 달력은 여전히 들고 있던 걸 쓴다
    await openCalendar(api);
    expect(calls).toHaveLength(0);
  });
});
