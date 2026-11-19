/**
 * D1 읽기 예산 테스트 (재발 방지).
 * 2026-09-30 카테고리 옮기기가 상관 서브쿼리로 (건수)² 행을 읽어 무료 플랜 하루 한도(계정 전체 500만 행)를 넘겼다.
 * 진짜 D1(로컬 workerd)에 3년 치 규모(7,000건)의 가짜 기록을 넣고, 화면이 부르는 API 와 한 번만 도는 작업이
 * 실제로 몇 행을 읽는지 재서 상한을 넘으면 실패한다. 새 쿼리·API 를 추가하면 여기에도 넣는다.
 * 같은 조회를 2,000건일 때도 재서, 건수가 3.5배가 될 때 읽기도 그 정도로만 느는지(제곱으로 늘지 않는지) 본다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countReads, json, REQUEST_READ_BUDGET, type SqlDb } from "@homebase/db";
import { openLocalD1 } from "@homebase/db/d1-local";
import { forgetDisplayNames, forgetRecurring, ledgerServer } from "./index.ts";
import { forgetMemoUses } from "./memos.ts";
import { recategorizeAll, resetCategoryVersionCheck } from "./recategorize.ts";
import { dropPhotos, movePhotos, refsWithPhotos } from "@homebase/core/photos";

const N = 7000;
const SMALL = 2000;
const DAYS = 3 * 365;
const START = Date.UTC(2023, 9, 1);
const day = (i: number) => new Date(START + (i % DAYS) * 86_400_000).toISOString().slice(0, 10);
const SOURCES = ["식비 > 한식", "식비 > 배달", "카페/간식 > 커피/음료", "생활 > 편의점", "교통 > 대중교통", "미분류 > 미분류", "주거/통신 > 휴대폰"];

let d1: Awaited<ReturnType<typeof openLocalD1>>;
let db: SqlDb;
const api = ledgerServer.createApi();

/** fn 이 읽은 행 수 */
async function reads(fn: (db: SqlDb) => Promise<unknown>): Promise<number> {
  const counted = countReads(db);
  await fn(counted);
  return counted.rowsRead;
}

const call = (path: string, init?: RequestInit) => async (counted: SqlDb) => {
  const r = await api.request(path, init, { DB: counted });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return r.json();
};

const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** 가짜 기록 [from, to) 번째를 넣는다 (지출 대부분, 수입 조금, 116건마다 확인 필요 이체) */
async function seed(from: number, to: number) {
  const rows = Array.from({ length: to - from }, (_, j) => {
    const i = from + j;
    return {
      kind: i % 50 === 0 ? "income" : i % 116 === 0 ? "transfer" : "expense",
      status: i % 116 === 0 ? "review" : "active",
      date: day(i * 7),
      time: `${String(8 + (i % 13)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
      merchant: i % 116 === 0 ? `가짜상대방${i % 20}` : `가짜가게${i % 300}`,
      amount: i % 50 === 0 ? 100_000 : -(1000 + (i % 97) * 100),
      method: i % 3 ? "가짜신용카드" : "가짜페이",
      source: SOURCES[i % SOURCES.length],
      key: `k${i}`,
    };
  });
  for (let i = 0; i < rows.length; i += 1000) {
    await db
      .prepare(
        `INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, payment_method, source_category, category_source, source, dedupe_key)
         SELECT v ->> 'kind', v ->> 'status', v ->> 'date', v ->> 'time', v ->> 'merchant', v ->> 'amount', v ->> 'method', v ->> 'source', 'source', 'test', v ->> 'key'
         FROM (SELECT value AS v FROM json_each(?))`,
      )
      .bind(json(rows.slice(i, i + 1000)))
      .run();
  }
}

/** 가져오기 한 조각(500건). 키가 같으면 두 번째부터는 전부 '이미 있음' */
const importPayload = (prefix: string) => ({
  source: "banksalad-xlsx",
  fileName: "fake.xlsx",
  fileSha256: "f".repeat(64),
  rows: Array.from({ length: 500 }, (_, i) => ({
    kind: "expense",
    date: day(i * 2),
    time: "12:00:00",
    merchant: `새가게${i % 50}`,
    amount: -1000 - i,
    paymentMethod: "가짜신용카드",
    sourceCategory: { major: "식비", minor: "한식" },
    dedupeKey: `${prefix}${i}`.padEnd(64, "0"),
  })),
  skipped: [],
  snapshot: null,
});

/** 건수에 따라 늘어나는지 볼 조회들 (DB 를 바꾸지 않는 것만) */
async function measureReadOnly() {
  forgetDisplayNames();
  return {
    recategorizeAgain: await reads((c) => recategorizeAll(c)), // 이미 옮긴 뒤라 바뀌는 것 없음
    monthFirst: await reads(call("/transactions?from=2026-09-01&to=2026-09-30")),
    monthCached: await reads(call("/transactions?from=2026-09-01&to=2026-09-30")),
    year: await reads(call("/transactions?from=2026-01-01&to=2026-12-31")),
    threeYears: await reads(call("/transactions?from=2023-10-01&to=2026-09-30")),
    overview: await reads(call("/")),
    review: await reads(call("/review")),
    importPreview: await reads(post("/imports/preview", importPayload("probe"))),
    search: await reads(call(`/search?q=${encodeURIComponent("가짜가게1")}`)),
    memos: await reads((c) => (forgetMemoUses(), call("/memos")(c))),
    recurring: await reads((c) => (forgetRecurring(), call("/recurring")(c))),
    searchTerms: await reads((c) => (forgetDisplayNames(), forgetMemoUses(), call("/search/terms")(c))),
  };
}

let small: Awaited<ReturnType<typeof measureReadOnly>>;

beforeAll(async () => {
  d1 = await openLocalD1();
  db = d1.db;
  await seed(0, SMALL);
  await recategorizeAll(db);
  small = await measureReadOnly();
  await seed(SMALL, N);
}, 60_000);

afterAll(async () => {
  await d1?.dispose();
});

describe(`D1 읽기 예산 (기록 ${N.toLocaleString()}건)`, () => {
  it("카테고리 옮기기는 건수에 비례해서만 읽는다", async () => {
    resetCategoryVersionCheck();
    const n = await reads((c) => recategorizeAll(c));
    console.log("recategorizeAll", n);
    expect(n).toBeLessThan(8 * N); // 상관 서브쿼리였으면 수천만 행
    // 다시 돌리면 바뀌는 게 없어서 훨씬 적게 읽는다
    const again = await reads((c) => recategorizeAll(c));
    console.log("recategorizeAll again", again);
    expect(again).toBeLessThan(1.5 * N);
  });

  it("화면이 부르는 조회", async () => {
    forgetDisplayNames();
    const monthFirst = await reads(call("/transactions?from=2026-09-01&to=2026-09-30"));
    const monthCached = await reads(call("/transactions?from=2026-09-01&to=2026-09-30"));
    const year = await reads(call("/transactions?from=2026-01-01&to=2026-12-31"));
    const threeYears = await reads(call("/transactions?from=2023-10-01&to=2026-09-30"));
    const overview = await reads(call("/"));
    const review = await reads(call("/review"));
    const categories = await reads(call("/categories"));
    const settings = await reads(call("/settings"));
    const notify = await reads(call("/notify/overview"));
    const mailConfig = await reads(call("/mail-config"));
    const summary = await reads(call("/cash-receipts/summary?year=2026"));
    const search = await reads(call(`/search?q=${encodeURIComponent("가짜가게1")}`));
    const searchAmount = await reads(call("/search?q=5000"));
    const searchUncategorized = await reads(call(`/search?q=${encodeURIComponent("미분류")}`));
    console.log({ monthFirst, monthCached, year, threeYears, overview, review, categories, settings, notify, mailConfig, summary, search, searchAmount, searchUncategorized });

    expect(monthFirst).toBeLessThan(2 * N); // 첫 조회는 가맹점 이름 묶기 때문에 전체를 한 번 훑는다
    expect(monthCached).toBeLessThan(1_000); // 그다음부터는 그 달 기록만 (조인 없이 행당 약 2)
    expect(year).toBeLessThan(6_000);
    expect(threeYears).toBeLessThan(22_000);
    expect(overview).toBeLessThan(500); // 탭을 옮길 때마다 불린다 → 인덱스로 확인 필요만
    expect(review).toBeLessThan(1_000);
    expect(categories + settings + summary).toBeLessThan(5_000);
    expect(notify).toBeLessThan(1_000); // 임시 거래는 부분 인덱스로, 원문은 50건만
    expect(mailConfig).toBeLessThan(50); // 설정 한 줄만 (ledger_settings 기본 키)
    expect(search).toBeLessThan(1.5 * N); // LIKE '%…%' 라 전체를 한 번 훑는다. 그 이상이면 안 됨
    // 검색은 **한 번 더** 읽는다 — 찾은 결제를 취소한 환불 줄(가게 이름 인덱스)을 같이 주기 때문.
    // 결과가 200건이면 가게도 200곳이라 그만큼 색인을 짚는다. 그래도 건수에 비례할 뿐이다
    expect(searchAmount).toBeLessThan(1.6 * N);
    expect(searchUncategorized).toBeLessThan(1.6 * N);
  });

  it("메모 자동완성·같은 결제에 한 번에 넣기", async () => {
    forgetMemoUses();
    const suggest = await reads(call("/memos"));
    const suggestCached = await reads(call("/memos"));
    const similar = await reads(call(`/memos/similar?merchant=${encodeURIComponent("가짜가게7")}&amount=-1700`));
    const apply = await reads(post("/memos/apply", { merchant: "가짜가게7", amount: null, memo: "가짜메모", remember: true }));
    const catSimilar = await reads(call(`/categories/similar?merchant=${encodeURIComponent("가짜가게8")}&amount=-1800&categoryId=1`));
    const catApply = await reads(post("/categories/apply", { merchant: "가짜가게8", amount: -1800, categoryId: 1, remember: true }));
    expect(catSimilar).toBeLessThan(500);
    expect(catApply).toBeLessThan(500);
    console.log({ suggest, suggestCached, similar, apply });
    expect(suggest).toBeLessThan(1.5 * N); // 메모 있는 기록만 묶지만 전체를 한 번 훑는다 → 10분 캐시
    expect(suggestCached).toBe(0);
    expect(similar).toBeLessThan(500); // 가게 이름 인덱스로 그 가게만
    expect(apply).toBeLessThan(500);
  });

  it("검색 자동완성 목록", async () => {
    forgetDisplayNames();
    forgetMemoUses();
    const first = await reads(call("/search/terms"));
    const cached = await reads(call("/search/terms"));
    console.log({ searchTermsFirst: first, searchTermsCached: cached });
    expect(first).toBeLessThan(3 * N); // 가게 이름 묶기 + 메모 묶기, 각각 전체 한 번 → 둘 다 10분 캐시
    expect(cached).toBe(0);
  });

  it("구글 캘린더 지출 기록의 상세 메모 넣기 (3년 치 400개)", async () => {
    const items = Array.from({ length: 400 }, (_, i) => ({ date: day(i * 7 * 17), amount: 1000 + ((i * 17) % 97) * 100, title: `가짜가게${(i * 17) % 300}`, note: `가짜 상세 ${i}` }));
    const preview = await reads(post("/notes/preview", { items }));
    const apply = await reads(post("/notes/apply", { items }));
    console.log({ notesPreview: preview, notesApply: apply });
    expect(preview).toBeLessThan(1.5 * N); // 기록 기간(3년)의 지출을 한 번 읽는다
    expect(apply).toBeLessThan(2.5 * N); // 다시 읽기 + 임시 표로 고치기 (행마다 다시 훑지 않음)
  });

  it("정기 결제", async () => {
    forgetRecurring();
    const first = await reads(call("/recurring"));
    const cached = await reads(call("/recurring"));
    console.log({ recurringFirst: first, recurringCached: cached });
    expect(first).toBeLessThan(1.5 * N); // 최근 2년 치를 한 번 (날짜 인덱스) → 10분 캐시
    expect(cached).toBeLessThan(500); // 그다음엔 카테고리·설정 같은 작은 표만
  });

  it("확인 필요 처리·거래 수정", async () => {
    const decide = await reads(post("/review/decide", { counterparty: "가짜상대방3", action: "expense", newCategory: "보험" }));
    const patch = await reads(call("/transactions/10", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memo: "메모" }) }));
    const syncReport = await reads(post("/sync-status", { ok: true }));
    console.log({ decide, patch, syncReport });
    expect(decide).toBeLessThan(1_000);
    expect(patch).toBeLessThan(100);
    expect(syncReport).toBeLessThan(10); // 10분마다 오므로 설정 한 행만
  });

  it("사진 (거래 300건에 900장) — 줄 표시·옮기기·지우기", async () => {
    // 사진 표는 작다(혼자 쓰는 앱). 그래도 거래 표를 훑지 않는지 본다 — host/src/worker/photos.ts 와 같은 쿼리
    await reads((c) =>
      c.prepare(
        `INSERT INTO core_photos (id, app, ref, bytes)
         SELECT 'b' || t.id || '_' || k.value, 'ledger', CAST(t.id AS TEXT), 300000
         FROM (SELECT id FROM ledger_transactions ORDER BY id LIMIT 300) t, json_each('[1,2,3]') k`,
      ).run(),
    );
    const marks = await reads((c) => c.prepare("SELECT ref, count(*) AS n FROM core_photos WHERE app = ? GROUP BY ref").bind("ledger").all());
    const list = await reads((c) => c.prepare("SELECT id, width, height FROM core_photos WHERE app = ? AND ref = ? ORDER BY created_at, id").bind("ledger", "10").all());
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    const which = await reads((c) => refsWithPhotos(c, "ledger", ids));
    const move = await reads((c) => movePhotos(c, "ledger", 10, 11));
    const drop = await reads((c) => dropPhotos(c, undefined, "ledger", ids));
    console.log({ marks, list, which, move, drop });
    expect(marks).toBeLessThan(2_000); // 사진 줄만 (거래 표 아님)
    expect(list).toBeLessThan(20); // (app, ref) 인덱스
    expect(which).toBeLessThan(2_000);
    expect(move).toBeLessThan(20);
    expect(drop).toBeLessThan(3_000);
  });

  it("가져오기 한 조각(500건) 미리보기·저장", async () => {
    const payload = importPayload("new");
    const preview = await reads(post("/imports/preview", payload));
    const commit = await reads(post("/imports", payload));
    console.log({ preview, commit });
    expect(preview).toBeLessThan(5_000);
    expect(commit).toBeLessThan(10_000);
  });

  it("현금영수증 미리보기·저장 (70건)", async () => {
    const receipts = Array.from({ length: 70 }, (_, i) => ({
      approvalNo: `R${i}`,
      date: day(900 + i * 2),
      time: null,
      merchant: `가짜가게${i}`,
      amount: 1000 + i * 100,
      kind: "general",
    }));
    const preview = await reads(post("/cash-receipts/preview", { receipts, skipped: [] }));
    const commit = await reads(post("/cash-receipts", { receipts, skipped: [] }));
    console.log({ preview, commit });
    expect(preview).toBeLessThan(5_000);
    expect(commit).toBeLessThan(6_000);
  });

  it(`건수가 ${SMALL.toLocaleString()} → ${N.toLocaleString()}건일 때 읽기도 비례해서만 는다`, async () => {
    const large = await measureReadOnly();
    const ratio = N / SMALL; // 3.5. 제곱으로 늘면 12배가 넘는다
    const grew = Object.fromEntries(Object.keys(small).map((k) => [k, +(large[k as keyof typeof large] / Math.max(1, small[k as keyof typeof small])).toFixed(2)]));
    console.log({ small, large, grew });
    for (const key of Object.keys(small) as (keyof typeof small)[]) {
      // 작은 값은 고정 비용 때문에 흔들리므로 200행 여유
      expect(large[key], key).toBeLessThan(small[key] * ratio * 1.6 + 200);
    }
  });

  it("가장 무거운 작업도 요청당 읽기 상한의 절반 안", async () => {
    resetCategoryVersionCheck();
    await db.prepare("UPDATE ledger_transactions SET category_id = NULL, category_source = 'source'").run();
    const heaviest = await reads((c) => recategorizeAll(c)); // 처음 옮길 때 (전부 바뀜)
    console.log({ heaviest, budget: REQUEST_READ_BUDGET });
    expect(heaviest).toBeLessThan(REQUEST_READ_BUDGET / 2);
  });

  it("카테고리 관리 (목록·이름·합치기·순서)", async () => {
    type Usage = { id: number; name: string; parentId: number | null; transactions: number };
    let list: Usage[] = [];
    // 첫 조회가 진짜 첫 조회여야 한다 — 미리 한 번 부르면 rev-cache 가 채워져 둘 다 캐시 값이 된다
    const first = await reads(async (c) => (list = (await call("/categories/manage")(c)) as Usage[]));
    const cached = await reads(call("/categories/manage"));
    // 많이 쓰인 소분류 둘을 합친다 (가장 무거운 길)
    const minors = list.filter((c) => c.parentId !== null).sort((a, b) => b.transactions - a.transactions);
    const [from, into] = [minors[0]!, minors[1]!];
    const rename = await reads(call(`/categories/${into.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `${into.name}2` }) }));
    const merge = await reads(post(`/categories/${from.id}/merge`, { into: into.id }));
    const majors = list.filter((c) => c.parentId === null).map((c) => c.id);
    const order = await reads(post("/categories/order", { parentId: null, ids: [...majors].reverse() }));
    console.log({ categoriesFirst: first, categoriesCached: cached, rename, merge, order });
    expect(first).toBeLessThan(3 * N); // 거래 표를 한 번 훑어 카테고리별로 센다 (달력 첫 조회와 같은 급) → rev-cache
    expect(cached).toBeLessThan(500); // 바뀐 게 없으면 카테고리 표 + 캐시 두 행
    // 고치는 쪽은 캐시를 안 쓰고 다시 세므로 매번 전체 한 번 훑기가 깔린다
    expect(rename).toBeLessThan(3 * N);
    expect(order).toBeLessThan(3 * N);
    // 합치기는 거래 표를 고치면서도 훑는다. 사람이 가끔 한 번 누르는 일이라 이 정도는 둔다
    expect(merge).toBeLessThan(6 * N);
    expect(merge).toBeLessThan(REQUEST_READ_BUDGET / 2);
  });
});

describe("상관 서브쿼리 금지 (소스 검사)", () => {
  it("JSON 을 행마다 다시 훑는 서브쿼리가 없다", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      // 주석은 빼고 본다 (설명에 나쁜 예를 적어 둘 수 있으므로)
      const src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // (SELECT … FROM json_each(?) … WHERE …) 모양: 바깥 행마다 JSON 전체를 다시 읽는다
      if (/\(\s*SELECT[^()]*FROM\s+json_each\(\?\)[^()]*\bWHERE\b/i.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
