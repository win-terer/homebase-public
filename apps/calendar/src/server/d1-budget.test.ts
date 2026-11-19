/**
 * 일정 D1 읽기 예산 (apps/ledger/src/server/d1-budget.test.ts 와 같은 방식).
 * 진짜 D1(로컬 workerd)에 3년 치 일정(하루 3개꼴 3,000건 + 반복 30개)을 넣고 한 달 보기가 몇 행을 읽는지 잰다.
 * 그 앞 3년 치(3,000건)를 더 넣어도 한 달 보기 읽기는 그대로인지(시작일 인덱스로 기간 근처만) 본다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countReads, json, type SqlDb } from "@homebase/db";
import { openLocalD1 } from "@homebase/db/d1-local";
import { calendarServer } from "./index.ts";

const N = 3000;
const START = Date.UTC(2023, 9, 1);
const day = (i: number) => new Date(START + i * 86_400_000).toISOString().slice(0, 10);

let d1: Awaited<ReturnType<typeof openLocalD1>>;
let db: SqlDb;
const api = calendarServer.createApi();

async function reads(path: string): Promise<number> {
  const counted = countReads(db);
  const r = await api.request(path, undefined, { DB: counted });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  await r.json();
  return counted.rowsRead;
}

/** 3년 치 일정 N건 (하루 약 3개, 100건마다 3일짜리). offset 일만큼 옮겨서 넣는다 */
async function seed(offset: number) {
  const rows = Array.from({ length: N }, (_, i) => {
    const d = offset + Math.floor((i * 1095) / N);
    return { title: `가짜 일정 ${i}`, start: day(d), end: i % 100 === 0 ? day(d + 2) : day(d) };
  });
  await db
    .prepare(
      `INSERT INTO calendar_events (title, start_date, end_date)
       SELECT v ->> 'title', v ->> 'start', v ->> 'end' FROM (SELECT value AS v FROM json_each(?))`,
    )
    .bind(json(rows))
    .run();
}

const month = "/events?from=2026-08-30&to=2026-10-10";
let before: number;

beforeAll(async () => {
  d1 = await openLocalD1();
  db = d1.db;
  await seed(0);
  for (let i = 0; i < 30; i++) {
    await db.prepare("INSERT INTO calendar_events (title, start_date, end_date, repeat) VALUES (?, ?, ?, ?)").bind(`반복 ${i}`, day(i * 30), day(i * 30), i % 2 ? "weekly" : "monthly").run();
  }
  before = await reads(month);
  await seed(-1095); // 그 앞 3년
}, 60_000);

afterAll(async () => {
  await d1?.dispose();
});

describe(`일정 D1 읽기 (${N.toLocaleString()}건 × 2)`, () => {
  it("한 달 보기는 그 근처 일정만 읽는다", async () => {
    const after = await reads(month);
    console.log({ calendarMonth3y: before, calendarMonth6y: after });
    // 한 달 + 앞 62일 치 일정(약 300건) + 반복 30개 + 카테고리. 전체(3,000건)를 훑으면 실패
    expect(before).toBeLessThan(600);
    // 기록이 두 배가 돼도 같은 기간을 보면 읽기는 그대로 (기간 밖 기록은 안 읽음)
    expect(after).toBeLessThan(before + 50);
    // 가계부 달력이 부르는 펼친 일정도 같은 쿼리
    const days = await reads(month.replace("/events", "/days"));
    expect(days).toBeLessThan(before + 50);
  });

  it("검색은 전체를 한 번 훑는다 (가계부 검색과 같은 모양)", async () => {
    // LIKE 라서 인덱스를 못 탄다 — 전체 한 번(건수 × 1)이 상한이고 **제곱이 아니어야** 한다.
    // Enter 때만 부르므로(화면) 이 정도는 받아들인 비용이다.
    const hit = await reads("/search?q=" + encodeURIComponent("가짜 일정 12"));
    console.log({ calendarSearch6y: hit });
    // 전체 6,030건 + json_each 조건·카테고리 몇백. 제곱이면 3,600만이라 여기서 바로 걸린다
    const total = N * 2 + 30;
    expect(hit).toBeLessThan(total + 500);
  });
});
