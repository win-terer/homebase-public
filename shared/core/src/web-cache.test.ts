import { beforeEach, describe, expect, it, vi } from "vitest";

/** 브라우저 흉내 (localStorage + fetch). 모듈이 상태를 들고 있어 매번 새로 읽어 온다 */
function browser(options: { rev?: string | null; storage?: boolean } = {}) {
  const { rev = "7.2026-10-02", storage = true } = options;
  const box = new Map<string, string>();
  if (storage) {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => box.get(k) ?? null,
      setItem: (k: string, v: string) => void box.set(k, v),
      removeItem: (k: string) => void box.delete(k),
    });
  } else {
    // 사생활 보호 모드처럼 쓰기만 하면 터지는 경우
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("차단됨");
      },
      setItem: () => {
        throw new Error("차단됨");
      },
      removeItem: () => {
        throw new Error("차단됨");
      },
    });
  }
  const calls: string[] = [];
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(url);
    if (rev === null) return Promise.resolve({ ok: false } as Response);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rev }) } as Response);
  });
  return { box, calls };
}

async function load() {
  vi.resetModules();
  return import("./web-cache.ts");
}

describe("브라우저 캐시", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("버전이 같으면 저장해 둔 걸 그대로 준다", async () => {
    browser();
    const c = await load();
    await c.primeRev();
    c.cacheSet("/api/ledger/transactions?from=a&to=b", [{ id: 1 }]);
    expect(c.cacheGet("/api/ledger/transactions?from=a&to=b")).toEqual([{ id: 1 }]);
  });

  it("버전을 물어보기 전에는 아무것도 주지 않는다 (틀린 걸 줄 바에 느린 게 낫다)", async () => {
    browser();
    const c = await load();
    c.cacheSet("/x", [1]);
    expect(c.cacheGet("/x")).toBeUndefined();
  });

  it("버전이 달라지면 저장해 둔 걸 쓰지 않는다", async () => {
    const first = browser({ rev: "7.2026-10-02" });
    const c1 = await load();
    await c1.primeRev();
    c1.cacheSet("/x", [1]);
    expect(c1.cacheGet("/x")).toEqual([1]);

    // 다음 방문: 저장된 내용은 그대로인데 서버 버전만 올랐다
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => first.box.get(k) ?? null,
      setItem: (k: string, v: string) => void first.box.set(k, v),
      removeItem: (k: string) => void first.box.delete(k),
    });
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: true, json: () => Promise.resolve({ rev: "8.2026-10-02" }) } as Response));
    const c2 = await load();
    await c2.primeRev();
    expect(c2.cacheGet("/x")).toBeUndefined();
  });

  it("버전을 못 물어보면 캐시를 쓰지 않는다", async () => {
    browser({ rev: null });
    const c = await load();
    await c.primeRev();
    c.cacheSet("/x", [1]);
    expect(c.cacheGet("/x")).toBeUndefined();
  });

  it("버전은 한 번만 물어본다", async () => {
    const { calls } = browser();
    const c = await load();
    await Promise.all([c.primeRev(), c.primeRev(), c.primeRev()]);
    expect(calls).toEqual(["/api/rev"]);
  });

  it("비우면 저장해 둔 것도 브라우저에서 사라진다 (로그아웃)", async () => {
    const { box } = browser();
    const c = await load();
    await c.primeRev();
    c.cacheSet("/x", [1]);
    expect(box.size).toBe(1);
    c.clearWebCache();
    expect(box.size).toBe(0);
    expect(c.cacheGet("/x")).toBeUndefined();
  });

  it("너무 큰 응답은 저장하지 않는다 (용량 한도를 혼자 다 쓰지 않게)", async () => {
    const { box } = browser();
    const c = await load();
    await c.primeRev();
    c.cacheSet("/big", ["x".repeat(1_000_001)]);
    expect(box.size).toBe(0);
  });

  it("localStorage 를 못 써도 터지지 않는다", async () => {
    browser({ storage: false });
    const c = await load();
    await c.primeRev();
    expect(() => c.cacheSet("/x", [1])).not.toThrow();
    expect(() => c.cacheGet("/x")).not.toThrow();
    expect(() => c.clearWebCache()).not.toThrow();
  });
});
