import { chunks, json, type SqlDb, type SqlStatement } from "@homebase/db";
import { movePhotos } from "@homebase/core/photos";
import { ImportError, type ImportPayload, type ImportRow, type ParseResult, type TransactionKind } from "../importers/types.ts";
import type { Classifier } from "../importers/rules.ts";
import { categorize, pairKey } from "../importers/categorize.ts";
import { ensureCategories } from "./categories.ts";
import { counterpartyKey, kindForAction, loadTransferRules } from "./transfer-rules.ts";
import { categoryRuleKey, forgetMemoUses, loadCategoryRules, loadMemoRules, memoRuleKey } from "./memos.ts";

export type Outcome = "new" | "duplicate" | "excluded";

export interface PlannedRow {
  tx: ImportRow;
  /** 규칙 적용 후 종류 (예: 이체를 지출로) */
  kind: TransactionKind;
  /** 규칙이 정한 카테고리 (없으면 소스 카테고리 사용) */
  ruleCategoryId?: number | null;
  outcome: Outcome;
  status: "active" | "review";
  /** 제외 또는 확인 필요 사유 */
  reason?: string;
}

export interface ImportSummary {
  source: { id: string; label: string };
  period: { from: string; to: string } | null;
  total: number;
  new: number;
  newByKind: Record<TransactionKind, number>;
  duplicates: number;
  /** 새로 들어가지만 사용자 확인이 필요한 이체 */
  review: number;
  /** 사유별 제외 건수 */
  excluded: Record<string, number>;
  skipped: ParseResult["skipped"];
}

export interface ImportPlan {
  rows: PlannedRow[];
  summary: ImportSummary;
}

/**
 * 받은 거래를 DB 와 비교해 무엇이 새로 들어갈지 계산한다. DB 는 바꾸지 않는다 (쿼리 2번).
 * 중복 제거 키는 브라우저에서 계산해 온다 (`importers/dedupe.ts`).
 */
export async function planImport(
  db: SqlDb,
  source: { id: string; label: string; classify: Classifier },
  payload: Pick<ImportPayload, "rows" | "skipped">,
): Promise<ImportPlan> {
  const rules = await loadTransferRules(db);
  const existing = new Set<string>();
  for (const part of chunks(payload.rows.map((r) => r.dedupeKey), 2000)) {
    const found = await db
      .prepare("SELECT dedupe_key AS k FROM ledger_transactions WHERE dedupe_key IN (SELECT value FROM json_each(?))")
      .bind(json(part))
      .all<{ k: string }>();
    for (const r of found.results) existing.add(r.k);
  }

  const rows: PlannedRow[] = payload.rows.map((tx) => {
    const outcome: Outcome = existing.has(tx.dedupeKey) ? "duplicate" : "new";

    // 브라우저가 파일 전체를 보고 정한 제외(간편결제 중복)는 다른 판단보다 앞선다
    if (tx.excludeReason) return { tx, kind: tx.kind, outcome: "excluded", status: "active", reason: tx.excludeReason };

    // 이체는 사용자 규칙이 소스의 기본 판단보다 우선한다
    const rule = tx.kind === "transfer" ? rules.get(counterpartyKey(tx.merchant)) : undefined;
    if (rule) {
      const kind = kindForAction(rule.action);
      if (!kind) return { tx, kind: tx.kind, outcome: "excluded", status: "active", reason: `규칙: ${counterpartyKey(tx.merchant)}` };
      return { tx, kind, ruleCategoryId: rule.categoryId, outcome, status: "active" };
    }

    const { decision, reason } = source.classify(tx);
    if (decision === "exclude") return { tx, kind: tx.kind, outcome: "excluded", status: "active", reason };
    if (decision === "review") return { tx, kind: tx.kind, outcome, status: "review", reason };
    return { tx, kind: tx.kind, outcome, status: "active" };
  });

  const dates = payload.rows.map((t) => t.date).sort();
  const summary: ImportSummary = {
    source: { id: source.id, label: source.label },
    period: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    total: payload.rows.length,
    new: 0,
    newByKind: { expense: 0, income: 0, transfer: 0 },
    duplicates: 0,
    review: 0,
    excluded: {},
    skipped: payload.skipped,
  };
  for (const row of rows) {
    if (row.outcome === "new") {
      summary.new++;
      summary.newByKind[row.kind]++;
      if (row.status === "review") summary.review++;
    } else if (row.outcome === "duplicate") {
      summary.duplicates++;
    } else {
      const key = row.reason ?? "기타";
      summary.excluded[key] = (summary.excluded[key] ?? 0) + 1;
    }
  }
  return { rows, summary };
}

/** 한 번에 넣는 행 수. JSON 한 값이 D1 크기 제한(약 2MB)을 넘지 않게 나눈다 */
const INSERT_CHUNK = 500;

/**
 * 계획의 새 행을 저장한다. 이미 있는 행은 건드리지 않으므로 메모·카테고리 수정이 유지된다.
 * 행마다 쿼리를 날리지 않고 JSON 덩어리로 넣어서, 몇천 건이어도 쿼리는 열 번 안쪽이다.
 */
/** 사진을 붙인 앱알림 줄 (이 기간). 사진 표가 아직 없으면(마이그레이션 전) 빈 목록 */
async function notifyRowsWithPhotos(db: SqlDb, period: { from: string; to: string }) {
  const refs = await db
    .prepare("SELECT DISTINCT ref FROM core_photos WHERE app = 'ledger'")
    .all<{ ref: string }>()
    .then((r) => r.results.map((x) => x.ref).filter((x) => /^\d+$/.test(x)))
    .catch(() => [] as string[]);
  if (!refs.length) return [];
  return (
    await db
      .prepare(
        `SELECT id, date, time, amount, merchant FROM ledger_transactions
         WHERE id IN (SELECT value FROM json_each(?)) AND source = 'notify' AND date BETWEEN ? AND ?`,
      )
      .bind(json(refs.map(Number)), period.from, period.to)
      .all<{ id: number; date: string; time: string | null; amount: number; merchant: string }>()
  ).results;
}

/** 짝을 못 찾은 앱알림 메모를 남겨 두는 설정 키. 날짜 상세가 `notify.lost.<날짜>.` 로 그날 것을 찾는다 */
export const lostMemoKey = (c: { date: string; amount: number; time: string | null }) => `notify.lost.${c.date}.${c.amount}.${c.time ?? "-"}`;

export async function commitImport(
  db: SqlDb,
  plan: ImportPlan,
  file: { name: string; sha256: string },
  /** 나눠 보낸 두 번째 조각부터는 첫 조각의 기록에 이어 붙인다 */
  existingBatchId?: number,
): Promise<{ batchId: number; inserted: number; lostMemos: number }> {
  const fresh = plan.rows.filter((r) => r.outcome === "new");

  // 소스(뱅크샐러드) 분류와 가맹점 이름으로 homebase 카테고리를 정한다 (importers/categorize.ts). 이체는 카테고리 없음
  const sourcePair = (r: PlannedRow) => categorize({ ...r.tx, kind: r.kind, sourceCategory: r.tx.sourceCategory ?? null });
  const categoryIds = await ensureCategories(
    db,
    fresh.filter((r) => r.ruleCategoryId === undefined).flatMap((r) => sourcePair(r) ?? []),
  );

  const { summary } = plan;

  /**
   * 앱 알림으로 먼저 들어온 기록(`source = 'notify'`)에 **사용자가 손댄 것**을 떼어 둔다.
   *
   * 결제 직후가 메모를 달기 제일 좋은 때다(뭘 샀는지 기억하고 있으니까). 그런데 엑셀이
   * 그 기간을 덮으면서 그 줄을 지우면 **메모와 분류가 같이 날아간다.** 그래서 지우기 전에
   * 떼어 두고, 엑셀 줄을 넣은 뒤 같은 결제에 옮겨 붙인다.
   *
   * 메모는 사람만 넣는다. 분류는 알림을 받을 때 규칙으로 추측해 넣기도 하므로(`notify-category.ts`,
   * `category_source = 'rule'`) **사람이 고른 것(`manual`)만** 옮긴다 — 추측이 엑셀 분류를 밀어내면 안 된다.
   */
  const carried = summary.period
    ? (
        await db
          .prepare(
            `SELECT id, date, time, amount, merchant, memo, CASE WHEN category_source = 'manual' THEN category_id END AS categoryId
             FROM ledger_transactions
             WHERE source = 'notify' AND date BETWEEN ? AND ?
               AND (memo IS NOT NULL OR (category_id IS NOT NULL AND category_source = 'manual'))`,
          )
          .bind(summary.period.from, summary.period.to)
          .all<{ id: number; date: string; time: string | null; amount: number; merchant: string; memo: string | null; categoryId: number | null }>()
      ).results
    : [];
  // 사진을 붙인 앱알림 줄도 같은 결제로 옮긴다 (사진만 있고 메모·분류는 없는 줄 포함).
  // 사진 표에서 먼저 찾고(사진은 몇 장 안 된다) 그중 이 기간의 앱알림 줄만 고른다 — 기간 전체를 훑지 않는다
  const withPhotos = summary.period ? await notifyRowsWithPhotos(db, summary.period) : [];
  const photoIds = new Set(withPhotos.map((r) => r.id));
  for (const r of withPhotos) if (!carried.some((c) => c.id === r.id)) carried.push({ ...r, memo: null, categoryId: null });

  // 메모 규칙 (같은 원래 가게 이름·같은 금액 → 메모, 사용자가 "앞으로도 자동으로" 고른 것)
  const memoRules = fresh.length ? await loadMemoRules(db) : new Map<string, string>();
  // 카테고리 규칙 (같은 원래 가게 이름·같은 금액 → 카테고리, "앞으로도 자동으로" 고른 것). 이체 규칙보다는 뒤
  const categoryRules = fresh.length ? await loadCategoryRules(db) : new Map<string, number>();
  const known = existingBatchId
    ? await db.prepare("SELECT id FROM ledger_import_batches WHERE id = ? AND file_sha256 = ?").bind(existingBatchId, file.sha256).first<{ id: number }>()
    : null;
  if (existingBatchId && !known) throw new ImportError("이어서 저장할 가져오기 기록을 찾을 수 없어요. 처음부터 다시 해주세요.");
  const batchId =
    known?.id ??
    (
      await db
        .prepare(
          `INSERT INTO ledger_import_batches
             (source, file_name, file_sha256, period_from, period_to, total_rows, inserted, duplicates, excluded, skipped)
           VALUES (?, ?, ?, NULL, NULL, 0, 0, 0, 0, 0)`,
        )
        .bind(summary.source.id, file.name, file.sha256)
        .run()
    ).meta.last_row_id;

  const values = fresh.map((r) => {
    // 규칙이 적용된 건은 규칙의 카테고리(없으면 비움), 아니면 소스 카테고리
    const byRule = r.ruleCategoryId !== undefined;
    const pair = byRule ? null : sourcePair(r);
    const userRule = byRule || r.kind === "transfer" ? undefined : categoryRules.get(categoryRuleKey(r.tx.merchant, r.tx.amount));
    const categoryId = byRule ? r.ruleCategoryId! : userRule !== undefined ? userRule : pair ? categoryIds.get(pairKey(pair))! : null;
    const sc = r.tx.sourceCategory;
    return {
      kind: r.kind,
      status: r.status,
      date: r.tx.date,
      time: r.tx.time,
      merchant: r.tx.merchant,
      amount: r.tx.amount,
      paymentMethod: r.tx.paymentMethod,
      categoryId,
      categorySource: categoryId === null ? null : byRule || userRule !== undefined ? "rule" : "source",
      sourceCategory: sc ? [sc.major, sc.minor].filter(Boolean).join(" > ") : null,
      memo: r.tx.memo ?? memoRules.get(memoRuleKey(r.tx.merchant, r.tx.amount)) ?? null,
      dedupeKey: r.tx.dedupeKey,
    };
  });

  const statements: SqlStatement[] = chunks(values, INSERT_CHUNK).map((part) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO ledger_transactions
           (kind, status, date, time, merchant, amount, payment_method, category_id, category_source,
            source_category, memo, source, import_batch_id, dedupe_key)
         SELECT v ->> 'kind', v ->> 'status', v ->> 'date', v ->> 'time', v ->> 'merchant', v ->> 'amount',
                v ->> 'paymentMethod', v ->> 'categoryId', v ->> 'categorySource', v ->> 'sourceCategory',
                v ->> 'memo', ?, ?, v ->> 'dedupeKey'
         FROM (SELECT value AS v FROM json_each(?))`,
      )
      .bind(summary.source.id, batchId, json(part)),
  );
  // 전체를 다시 세지 않고 이번 조각에서 늘어난 만큼만 더한다 (조각마다 전체를 세면 D1 읽기가 쌓인다)
  const results = statements.length ? await db.batch(statements) : [];
  const inserted = results.reduce((n, r) => n + r.meta.changes, 0);
  await db
    .prepare(
      `UPDATE ledger_import_batches SET
         inserted = inserted + ?,
         total_rows = total_rows + ?, duplicates = duplicates + ?, excluded = excluded + ?, skipped = skipped + ?,
         period_from = min(ifnull(period_from, ?), ifnull(?, period_from)),
         period_to = max(ifnull(period_to, ?), ifnull(?, period_to))
       WHERE id = ?`,
    )
    .bind(
      inserted,
      summary.total,
      summary.duplicates,
      Object.values(summary.excluded).reduce((a, b) => a + b, 0),
      summary.skipped.length,
      summary.period?.from ?? null,
      summary.period?.from ?? null,
      summary.period?.to ?? null,
      summary.period?.to ?? null,
      batchId,
    )
    .run();
  /**
   * 떼어 둔 메모·분류를 같은 결제에 옮겨 붙인다.
   *
   * **가맹점 이름으로는 못 찾는다.** 알림은 결제대행사 이름으로 오고(네이버페이 →
   * "네이버파이낸셜(주)") 엑셀에는 진짜 가게 이름이 찍힌다. 그래서 **날짜 + 금액**으로 찾는다.
   *
   * 같은 날 같은 금액이 여럿이면 **시각이 정확히 같은 것 하나**일 때만 옮긴다. 아니면
   * 자동으로는 안 붙인다 — 엉뚱한 결제에 메모가 붙는 것보다 낫다. 대신 **버리지도 않는다**:
   * `notify.lost.<날짜>.<금액>.<시각>` 설정으로 남겨 두고(`lostMemo`), 날짜 상세에서 사람이
   * 어느 결제인지 골라 붙인다. 가져오기 결과에도 "옮기지 못한 메모 N건" 으로 알린다.
   */
  let lostMemos = 0;
  for (const c of carried) {
    const cands = (
      await db
        .prepare("SELECT id, time FROM ledger_transactions WHERE source <> 'notify' AND date = ? AND amount = ?")
        .bind(c.date, c.amount)
        .all<{ id: number; time: string | null }>()
    ).results;
    const exact = cands.filter((r) => r.time === c.time);
    const target = cands.length === 1 ? cands[0] : exact.length === 1 ? exact[0] : null;
    if (!target) {
      // 사진은 'lost:<키>' 로 옮겨 둔다 — 지운 줄의 id 는 나중에 새 줄이 다시 받을 수 있어서 그대로 두면 엉뚱한 결제에 붙는다
      const photos = photoIds.has(c.id) ? await movePhotos(db, "ledger", c.id, `lost:${lostMemoKey(c)}`) : 0;
      await db
        .prepare(
          `INSERT INTO ledger_settings (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .bind(lostMemoKey(c), JSON.stringify({ memo: c.memo, categoryId: c.categoryId, merchant: c.merchant, ...(photos ? { photos } : {}) }))
        .run();
      lostMemos++;
      continue;
    }
    if (photoIds.has(c.id)) await movePhotos(db, "ledger", c.id, target.id);
    if (!c.memo && c.categoryId === null) continue; // 사진만 옮기면 되는 줄
    await db
      .prepare(
        `UPDATE ledger_transactions SET
           memo = coalesce(?, memo),
           category_id = coalesce(?, category_id),
           -- 사람이 고른 분류는 'manual' 로 둬야 나중에 규칙이 덮어쓰지 않는다
           category_source = CASE WHEN ? IS NULL THEN category_source ELSE 'manual' END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .bind(c.memo, c.categoryId, c.categoryId, target.id)
      .run();
  }

  /**
   * 이제 앱 알림 줄을 치운다. **옮겨 붙인 뒤에** 지우는 순서가 중요하다.
   *
   * 알림은 엑셀이 오기 전까지 자리를 지키는 역할이다. 엑셀이 덮는 순간 쓸모가 끝난다 —
   * 엑셀 쪽이 카테고리·실제 가맹점 이름·취소 반영을 들고 있다. 남겨 두면 같은 결제가 두 번
   * 보인다(중복 제거 키가 소스마다 달라 자동으로는 안 걸린다).
   */
  if (summary.period) {
    await db
      .prepare("DELETE FROM ledger_transactions WHERE source = 'notify' AND date BETWEEN ? AND ?")
      .bind(summary.period.from, summary.period.to)
      .run();
  }

  if (memoRules.size && inserted) forgetMemoUses();
  return { batchId, inserted, lostMemos };
}
