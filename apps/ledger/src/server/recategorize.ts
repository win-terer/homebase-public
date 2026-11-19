/**
 * 카테고리 목록 개편(2026-09-30) 적용: 새 목록을 만들고 기존 기록을 옮긴다.
 * 버전을 app_meta 에 적어 두고, 버전이 낮으면 첫 요청 때 한 번만 실행한다.
 * 쿼리는 10개 남짓 (행마다 쿼리하지 않음).
 */
import { json, type SqlDb } from "@homebase/db";
import { CATEGORY_TREE, categorize, mapExistingCategory, pairKey, type CategoryPair } from "../importers/categorize.ts";
import { ensureCategories } from "./categories.ts";

/**
 * 3 = 2026-11-12 에 한 번 돌았다. 그때는 메모 낱말('몽이')로 분류까지 바꿨지만 **되돌렸다**
 * (분류 대신 태그로 가기로 함, 같은 날). 번호는 그대로 둬야 다시 안 돈다.
 */
export const CATEGORY_VERSION = "3";

/**
 * 여러 행을 한 번에 고칠 때 쓰는 임시 표. JSON 을 행마다 다시 훑는 상관 서브쿼리
 * (`(SELECT … FROM json_each(?) WHERE value->>'id' = t.id)`)는 D1 읽기가 (건수)² 로 늘어나서 쓰지 않는다.
 */
const SCRATCH_TABLE = "CREATE TABLE IF NOT EXISTS ledger_scratch (id INTEGER PRIMARY KEY, value INTEGER)";
const META_KEY = "ledger.category_version";

/** 새 목록의 카테고리를 만들고 표시 순서를 맞춘다. 돌려주는 맵의 키는 pairKey */
export async function ensureCategoryTree(db: SqlDb, extra: CategoryPair[] = []): Promise<Map<string, number>> {
  const pairs = [...CATEGORY_TREE.flatMap((g) => [{ major: g.major }, ...g.minors.map((minor) => ({ major: g.major, minor }))]), ...extra];
  const ids = await ensureCategories(db, pairs);
  const order = CATEGORY_TREE.flatMap((g, i) => [
    { id: ids.get(pairKey({ major: g.major }))!, sort: (i + 1) * 100 },
    ...g.minors.map((minor, j) => ({ id: ids.get(pairKey({ major: g.major, minor }))!, sort: j + 1 })),
  ]);
  await db.batch([
    db.prepare(SCRATCH_TABLE),
    db.prepare("DELETE FROM ledger_scratch"),
    db.prepare("INSERT INTO ledger_scratch (id, value) SELECT value ->> 'id', value ->> 'sort' FROM json_each(?)").bind(json(order)),
    db.prepare(
      "UPDATE ledger_categories SET sort_order = (SELECT s.value FROM ledger_scratch s WHERE s.id = ledger_categories.id) WHERE id IN (SELECT id FROM ledger_scratch)",
    ),
    db.prepare("DELETE FROM ledger_scratch"),
  ]);
  return ids;
}

const parseSource = (s: string | null) => {
  if (!s) return null;
  const [major, minor] = s.split(" > ");
  return { major: major!, ...(minor ? { minor } : {}) };
};

export async function recategorizeAll(db: SqlDb): Promise<{ transactions: number; rules: number; removed: number }> {
  type Row = { id: number; kind: "expense" | "income" | "transfer"; date: string; time: string | null; merchant: string; memo: string | null; sourceCategory: string | null; categorySource: string | null; categoryId: number | null; name: string | null; parent: string | null };
  // 기록마다 카테고리 표를 조인하면 D1 읽기가 행당 3배가 된다 → 카테고리(수십 행)는 따로 읽어 JS 에서 맞춘다
  const cats = new Map(
    (await db.prepare("SELECT id, name, parent_id AS parentId FROM ledger_categories").all<{ id: number; name: string; parentId: number | null }>()).results.map(
      (c) => [c.id, c],
    ),
  );
  const rows = (
    await db
      .prepare(
        `SELECT id, kind, date, time, merchant, memo, source_category AS sourceCategory, category_source AS categorySource, category_id AS categoryId
         FROM ledger_transactions`,
      )
      .all<Omit<Row, "name" | "parent">>()
  ).results.map((r): Row => {
    const c = r.categoryId !== null ? cats.get(r.categoryId) : undefined;
    const p = c?.parentId != null ? cats.get(c.parentId) : undefined;
    return { ...r, name: c?.name ?? null, parent: p?.name ?? null };
  });
  const rules = (
    await db
      .prepare(
        `SELECT r.rowid, r.counterparty, c.name, p.name AS parent FROM ledger_transfer_rules r
         JOIN ledger_categories c ON c.id = r.category_id LEFT JOIN ledger_categories p ON p.id = c.parent_id`,
      )
      .all<{ rowid: number; counterparty: string; name: string; parent: string | null }>()
  ).results;
  const ruleRowids = new Map(rules.map((r) => [r.counterparty, r.rowid]));

  // 자동으로 붙은 것은 다시 분류, 사용자가 고른 것(rule·manual)은 이름만 새 목록으로 옮김
  const target = new Map<number, CategoryPair | null>();
  for (const r of rows) {
    if (r.categorySource === "rule" || r.categorySource === "manual") {
      if (r.name) {
        const moved = mapExistingCategory(r.parent, r.name);
        if (moved) target.set(r.id, moved);
      }
    } else {
      target.set(r.id, categorize({ kind: r.kind, date: r.date, time: r.time, merchant: r.merchant, memo: r.memo, sourceCategory: parseSource(r.sourceCategory) }));
    }
  }
  const ruleTarget = new Map<string, CategoryPair>();
  for (const r of rules) {
    const moved = mapExistingCategory(r.parent, r.name);
    if (moved) ruleTarget.set(r.counterparty, moved);
  }

  const extra = [...target.values(), ...ruleTarget.values()].filter((p): p is CategoryPair => p !== null);
  const ids = await ensureCategoryTree(db, extra);
  // 카테고리가 실제로 바뀌는 행만 고친다 (쓰기·읽기 모두 줄임)
  const current = new Map(rows.map((r) => [r.id, r.categoryId]));
  const txUpdates = [...target]
    .map(([id, pair]) => ({ id, categoryId: pair ? ids.get(pairKey(pair))! : null }))
    .filter((u) => u.categoryId !== current.get(u.id));
  // 자동으로 붙은 것(출처 source/NULL)은 카테고리가 생기거나 없어질 때만 출처가 바뀐다
  const auto = new Map(rows.filter((r) => r.categorySource !== "rule" && r.categorySource !== "manual").map((r) => [r.id, r.categorySource]));
  const toSource = txUpdates.filter((u) => auto.has(u.id) && u.categoryId !== null && auto.get(u.id) !== "source").map((u) => u.id);
  const toNull = txUpdates.filter((u) => auto.has(u.id) && u.categoryId === null && auto.get(u.id) !== null).map((u) => u.id);
  const ruleUpdates = [...ruleTarget].map(([counterparty, pair]) => ({ rowid: ruleRowids.get(counterparty)!, categoryId: ids.get(pairKey(pair))! }));
  // ensureCategories 는 대분류 아래 옛 소분류까지 돌려주므로, 남길 것은 새 목록 + 지금 쓰는 것만
  const needed = [...CATEGORY_TREE.flatMap((g) => [{ major: g.major }, ...g.minors.map((minor) => ({ major: g.major, minor }))]), ...extra];
  const keep = [...new Set(needed.map((p) => ids.get(pairKey(p))!))];

  // 행마다 JSON 을 다시 훑는 상관 서브쿼리는 D1 읽기 행 수가 (건수)² 로 늘어난다 (1,800건 → 약 160만).
  // 그래서 임시 표(ledger_scratch, 기본 키)에 넣고 키로 찾는다 (약 1만).
  const results = await db.batch([
    db.prepare(SCRATCH_TABLE),
    db.prepare("DELETE FROM ledger_scratch"),
    db
      .prepare("INSERT INTO ledger_scratch (id, value) SELECT value ->> 'id', value ->> 'categoryId' FROM json_each(?)")
      .bind(json(txUpdates)),
    db.prepare(
      "UPDATE ledger_transactions SET category_id = (SELECT s.value FROM ledger_scratch s WHERE s.id = ledger_transactions.id) WHERE id IN (SELECT id FROM ledger_scratch)",
    ),
    // 자동으로 붙은 것의 출처만 맞춘다 (사용자가 고른 rule·manual 은 그대로)
    db.prepare("UPDATE ledger_transactions SET category_source = 'source' WHERE id IN (SELECT value FROM json_each(?))").bind(json(toSource)),
    db.prepare("UPDATE ledger_transactions SET category_source = NULL WHERE id IN (SELECT value FROM json_each(?))").bind(json(toNull)),
    db.prepare("DELETE FROM ledger_scratch"),
    db.prepare("INSERT INTO ledger_scratch (id, value) SELECT value ->> 'rowid', value ->> 'categoryId' FROM json_each(?)").bind(json(ruleUpdates)),
    db.prepare(
      "UPDATE ledger_transfer_rules SET category_id = (SELECT s.value FROM ledger_scratch s WHERE s.id = ledger_transfer_rules.rowid) WHERE rowid IN (SELECT id FROM ledger_scratch)",
    ),
    db.prepare("DELETE FROM ledger_scratch"),
    // 새 목록에 없고 아무도 안 쓰는 옛 카테고리 정리 (소분류부터)
    db
      .prepare(
        `DELETE FROM ledger_categories
         WHERE parent_id IS NOT NULL AND id NOT IN (SELECT value FROM json_each(?))
           AND id NOT IN (SELECT category_id FROM ledger_transactions WHERE category_id IS NOT NULL)
           AND id NOT IN (SELECT category_id FROM ledger_transfer_rules WHERE category_id IS NOT NULL)`,
      )
      .bind(json(keep)),
    db
      .prepare(
        `DELETE FROM ledger_categories
         WHERE parent_id IS NULL AND id NOT IN (SELECT value FROM json_each(?))
           AND id NOT IN (SELECT parent_id FROM ledger_categories WHERE parent_id IS NOT NULL)
           AND id NOT IN (SELECT category_id FROM ledger_transactions WHERE category_id IS NOT NULL)
           AND id NOT IN (SELECT category_id FROM ledger_transfer_rules WHERE category_id IS NOT NULL)`,
      )
      .bind(json(keep)),
    db
      .prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(META_KEY, CATEGORY_VERSION),
  ]);
  return { transactions: results[3]!.meta.changes, rules: results[8]!.meta.changes, removed: results[10]!.meta.changes + results[11]!.meta.changes };
}

/** 다른 요청이 옮기는 중이면 이 시간 동안은 기다리지 않고 넘어간다. 실패한 뒤 다시 시도할 때까지도 이만큼 기다린다 */
const RUNNING_TTL_MS = 5 * 60_000;
/**
 * 실패해도 이 횟수까지만 다시 시도한다. 읽기 상한에 걸려 실패하면 되돌리는 쿼리도 막혀서,
 * 횟수 제한이 없으면 5분마다 상한만큼 읽는 요청이 하루 종일 반복된다 (하루 한도를 넘김).
 * 다 실패하면 멈춘다 → 고친 코드를 배포하거나 D1 콘솔에서 app_meta 값을 지우면 다시 시도한다.
 */
const MAX_ATTEMPTS = 3;
let done = false;
let gaveUp = false;

/** 'running:<시각>[:<시도>]' 또는 'failed:<시각>:<시도>' */
function parseClaim(value: string | null): { at: number; attempt: number } | null {
  const m = value?.match(/^(?:running|failed):(\d+)(?::(\d+))?$/);
  return m ? { at: Number(m[1]), attempt: Number(m[2] ?? 1) } : null;
}

/**
 * 버전이 낮으면 한 번만 실행한다. 배포 직후에는 화면이 요청을 여러 개 동시에 보내므로
 * app_meta 값을 'running:<시각>:<시도>' 로 먼저 차지한(compare-and-swap) 요청 하나만 실행한다.
 */
export async function ensureCategoryVersion(db: SqlDb): Promise<void> {
  if (done || gaveUp) return;
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = ?").bind(META_KEY).first<{ value: string }>();
  const current = row?.value ?? null;
  if (current === CATEGORY_VERSION) {
    done = true;
    return;
  }
  const previous = parseClaim(current);
  if (previous && Date.now() - previous.at < RUNNING_TTL_MS) return;
  if (previous && previous.attempt >= MAX_ATTEMPTS) {
    gaveUp = true;
    console.error(`카테고리 옮기기가 ${MAX_ATTEMPTS}번 실패해서 멈췄어요 (app_meta ${META_KEY} = ${current})`);
    return;
  }

  const attempt = (previous?.attempt ?? 0) + 1;
  const claim = `running:${Date.now()}:${attempt}`;
  const claimed = current === null
    ? await db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)").bind(META_KEY, claim).run()
    : await db.prepare("UPDATE app_meta SET value = ? WHERE key = ? AND value = ?").bind(claim, META_KEY, current).run();
  if (claimed.meta.changes !== 1) return; // 다른 요청이 먼저 차지함
  try {
    await recategorizeAll(db); // 끝에 버전을 적는다
    done = true;
  } catch (e) {
    // 실패 표시를 남긴다. 다음 시도는 RUNNING_TTL_MS 뒤에 (이 쿼리가 막혀도 'running:' 이 남아 똑같이 기다린다)
    await db
      .prepare("UPDATE app_meta SET value = ? WHERE key = ? AND value = ?")
      .bind(`failed:${Date.now()}:${attempt}`, META_KEY, claim)
      .run()
      .catch(() => undefined);
    throw e;
  }
}

/** 테스트용: 인스턴스 안의 '이미 확인함' 표시를 지운다 */
export function resetCategoryVersionCheck() {
  done = false;
  gaveUp = false;
}
