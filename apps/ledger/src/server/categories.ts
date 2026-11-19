import { json, type SqlDb } from "@homebase/db";

const findCategory = (db: SqlDb, name: string, parentId: number | null) =>
  db
    .prepare("SELECT id FROM ledger_categories WHERE ifnull(parent_id, 0) = ? AND name = ?")
    .bind(parentId ?? 0, name)
    .first<{ id: number }>();

/** 이름으로 카테고리를 찾고, 없으면 만든다 */
export async function ensureCategory(db: SqlDb, name: string, parentId: number | null): Promise<number> {
  const row = await findCategory(db, name, parentId);
  if (row) return row.id;
  await db.prepare("INSERT OR IGNORE INTO ledger_categories (name, parent_id) VALUES (?, ?)").bind(name, parentId).run();
  return (await findCategory(db, name, parentId))!.id;
}

/** "대분류" 또는 "대분류 > 소분류" 이름으로 찾고, 없으면 만든다 (화면에서 새 카테고리를 만들 때) */
export async function ensureCategoryPath(db: SqlDb, path: string): Promise<number> {
  const [major, minor] = path.split(">").map((s) => s.trim().slice(0, 30));
  if (!major) throw new Error("카테고리 이름이 비어 있어요");
  const majorId = await ensureCategory(db, major, null);
  return minor ? ensureCategory(db, minor, majorId) : majorId;
}

/**
 * "대분류 > 소분류" 쌍 여러 개를 한꺼번에 찾거나 만든다 (쿼리 4번).
 * 돌려주는 맵의 키는 `대분류\u001f소분류` (소분류 없으면 `대분류\u001f`).
 */
export async function ensureCategories(db: SqlDb, pairs: { major: string; minor?: string }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!pairs.length) return out;
  const majors = [...new Set(pairs.map((p) => p.major))];
  await db
    .prepare("INSERT OR IGNORE INTO ledger_categories (name, parent_id) SELECT value, NULL FROM json_each(?)")
    .bind(json(majors))
    .run();
  const majorIds = new Map(
    (
      await db
        .prepare("SELECT id, name FROM ledger_categories WHERE parent_id IS NULL AND name IN (SELECT value FROM json_each(?))")
        .bind(json(majors))
        .all<{ id: number; name: string }>()
    ).results.map((r) => [r.name, r.id]),
  );
  for (const m of majors) out.set(`${m}\u001f`, majorIds.get(m)!);

  const minors = [...new Map(pairs.filter((p) => p.minor).map((p) => [`${p.major}\u001f${p.minor}`, { parent: majorIds.get(p.major)!, name: p.minor! }])).values()];
  if (!minors.length) return out;
  await db
    .prepare(
      "INSERT OR IGNORE INTO ledger_categories (name, parent_id) SELECT value ->> 'name', value ->> 'parent' FROM json_each(?)",
    )
    .bind(json(minors))
    .run();
  const parentName = new Map([...majorIds].map(([name, id]) => [id, name]));
  const rows = (
    await db
      .prepare("SELECT id, name, parent_id AS parent FROM ledger_categories WHERE parent_id IN (SELECT value FROM json_each(?))")
      .bind(json([...majorIds.values()]))
      .all<{ id: number; name: string; parent: number }>()
  ).results;
  for (const r of rows) out.set(`${parentName.get(r.parent)}\u001f${r.name}`, r.id);
  return out;
}

export interface CategoryOption {
  id: number;
  name: string;
  parentId: number | null;
  /** "상위 > 하위" 형태의 표시 이름 */
  label: string;
}

export async function listCategories(db: SqlDb): Promise<CategoryOption[]> {
  return (
    await db
      .prepare(
        `SELECT c.id, c.name, c.parent_id AS parentId, CASE WHEN p.id IS NULL THEN c.name ELSE p.name || ' > ' || c.name END AS label
         FROM ledger_categories c LEFT JOIN ledger_categories p ON p.id = c.parent_id
         ORDER BY ifnull(p.sort_order, c.sort_order), ifnull(p.name, c.name), p.id IS NOT NULL, c.sort_order, c.name`,
      )
      .all<CategoryOption>()
  ).results;
}
