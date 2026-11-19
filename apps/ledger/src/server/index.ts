import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv, ServerModule } from "@homebase/core/server";
import { json, ReadBudgetError, type SqlValue } from "@homebase/db";
import type { CashReceipt } from "../importers/cash-receipt-csv.ts";
import type { Snapshot } from "../importers/banksalad-snapshot.ts";
import { importSources } from "../importers/rules.ts";
import { ImportError, type ImportPayload, type ImportRow } from "../importers/types.ts";
import { cashReceiptSummary, commitCashReceipts, planCashReceipts, type PlannedReceipt } from "./cash-receipts.ts";
import { ensureCategoryPath, listCategories } from "./categories.ts";
import { CategoryError, deleteCategory, listCategoryUsage, mergeCategory, renameCategory, reorderCategories } from "./category-admin.ts";
import { commitImport, planImport } from "./imports.ts";
import { buildDisplayMap } from "./merchants.ts";
import { revCached } from "./rev-cache.ts";
import { findSimplePayDupes, removeSimplePayDupes } from "./duplicates.ts";
import { joinMemo, splitMemo } from "./memo.ts";
import { applyNotes, loadNoteTxs, matchNotes, parseNoteItems } from "./notes-import.ts";
import { applyCategory, applyMemo, forgetMemoUses, memoUses, similarCategory, similarWithoutMemo } from "./memos.ts";
import { detectRecurring, type RecurringInput } from "./recurring.ts";
import { parsePlan, planToRecurring, PLAN_PREFIX } from "./recurring-plan.ts";
import { parseNotification } from "./notify-parse.ts";
import { notifyCategory, rememberNotifyCategory } from "./notify-category.ts";
import { readSyncReport, readSyncStatus, recentNotifications, recordSyncReport } from "./notify-status.ts";
import { claimMailLink, loadMailConfig, makeMailLink, MailConfigError, saveMailConfig } from "./mail-config.ts";
import { sha256 } from "../importers/dedupe.ts";
import { deleteTagRule, loadTagRules, setTagRule, tagsOf, wordsForTag, RULE_MAX, TAG_MAX, WORD_MAX } from "./tags.ts";
/** 이 금액 미만 들어온 돈(이자·리워드)은 달력·정기 결제에서 빼고 통계에서만 (web/api.ts SMALL_INCOME_LIMIT 와 같게) */
const SMALL_INCOME_LIMIT = 1000;
import { counterpartyKey } from "./transfer-rules.ts";
import { decideReview, listReviewGroups } from "./review.ts";
import { latestSnapshot, saveSnapshot } from "./snapshots.ts";
import { ensureCategoryVersion } from "./recategorize.ts";

/**
 * 가맹점 표시 이름 (같은 곳의 다른 표기를 묶은 이름). 표기 통일은 전체 기록 기준이라 전체를 훑어야 해서,
 * 달력·통계를 열 때마다 D1 읽기가 쌓이지 않게 워커 인스턴스 안에서 10분 동안 기억한다 (이름 표시만 쓰므로 조금 늦어도 괜찮다).
 */
const NAMES_TTL_MS = 10 * 60_000;
let namesCache: { at: number; names: Map<string, string>; counts: Map<string, number> } | null = null;

async function loadNames(db: AppEnv["Bindings"]["DB"]) {
  if (namesCache && Date.now() - namesCache.at < NAMES_TTL_MS) return namesCache;
  // 표 전체를 훑는다(7,000건에 수만 행). isolate 가 바뀌어도 다시 하지 않게 D1 에 맡긴다 —
  // 데이터가 그대로면 2행만 읽고 끝난다 (rev-cache.ts).
  const rows = { results: await revCached(db, "names", async () =>
    (await db.prepare("SELECT merchant, count(*) AS n FROM ledger_transactions GROUP BY merchant").all<{ merchant: string; n: number }>()).results) };
  const names = buildDisplayMap(rows.results);
  // 보여줄 이름별 기록 수 (검색 자동완성용)
  const counts = new Map<string, number>();
  for (const r of rows.results) {
    const shown = names.get(r.merchant) ?? r.merchant;
    counts.set(shown, (counts.get(shown) ?? 0) + r.n);
  }
  namesCache = { at: Date.now(), names, counts };
  return namesCache;
}

async function displayNames(db: AppEnv["Bindings"]["DB"]): Promise<Map<string, string>> {
  return (await loadNames(db)).names;
}

/** 새 기록이 들어오면 다음 조회 때 다시 계산 */
export const forgetDisplayNames = () => {
  namesCache = null;
};

const TX_COLUMNS = `id, kind, date, time, merchant, memo, amount, payment_method AS paymentMethod,
  category_id AS categoryId, settles_id AS settlesId, source`;
type TxRow = { id: number; merchant: string; memo: string | null; categoryId: number | null } & Record<string, unknown>;
const SEARCH_LIMIT = 200;
/** 결제와 환불을 같은 건으로 보는 기간. 화면의 `CANCEL_WITHIN_DAYS`(web/api.ts)와 같게 둘 것 */
const CANCEL_WITHIN_DAYS = 7;
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** 찾은 줄들을 취소했을 수 있는 환불 줄 (같은 가게·검색 결과 기간 + 7일) */
async function refundsNear(db: AppEnv["Bindings"]["DB"], all: TxRow[]): Promise<TxRow[]> {
  // 취소될 수 있는 건 '나간 돈' 뿐이다 — 환불 줄 자체나 수입·이체는 찾을 필요가 없다
  const found = all.filter((r) => r.kind === "expense" && Number(r.amount) < 0);
  if (!found.length) return [];
  const shops = [...new Set(found.map((r) => r.merchant))];
  const dates = found.map((r) => String(r.date)).sort();
  const ids = all.map((r) => r.id);
  return (
    await db
      .prepare(
        `SELECT ${TX_COLUMNS} FROM ledger_transactions
         WHERE status = 'active' AND kind = 'expense' AND amount > 0
           AND merchant IN (SELECT value FROM json_each(?))
           AND date BETWEEN ? AND ?
           AND id NOT IN (SELECT value FROM json_each(?))`,
      )
      .bind(json(shops), dates[0]!, plusDays(dates[dates.length - 1]!, CANCEL_WITHIN_DAYS), json(ids))
      .all<TxRow>()
  ).results;
}

/**
 * 기록을 화면에 줄 때 붙이는 것들. 기록마다 카테고리·현금영수증 표를 조인하면 D1 읽기가 행당 3~4배가 된다.
 * 카테고리(수십 행)와 현금영수증이 붙은 거래 id(연 수십 건)는 따로 읽어 JS 에서 맞춘다.
 */
async function lookups(db: AppEnv["Bindings"]["DB"]) {
  const [cats, receipts, merchants, tagRules] = await Promise.all([
    db.prepare("SELECT id, name, parent_id AS parentId FROM ledger_categories").all<{ id: number; name: string; parentId: number | null }>(),
    db.prepare("SELECT transaction_id AS id FROM ledger_cash_receipts WHERE transaction_id IS NOT NULL").all<{ id: number }>(),
    displayNames(db),
    loadTagRules(db),
  ]);
  return { byId: new Map(cats.results.map((x) => [x.id, x])), withReceipt: new Set(receipts.results.map((r) => r.id)), merchants, tagRules };
}

/** 화면·통계에는 묶은 이름을, 원래 이름은 rawMerchant 로 함께 준다. 메모는 한 줄 메모와 상세로 나눈다 */
function present(r: TxRow, look: Awaited<ReturnType<typeof lookups>>) {
  const cat = r.categoryId !== null ? look.byId.get(r.categoryId) : undefined;
  const parent = cat?.parentId != null ? look.byId.get(cat.parentId) : undefined;
  return {
    ...r,
    ...splitMemo(r.memo),
    merchant: look.merchants.get(r.merchant) ?? r.merchant,
    rawMerchant: r.merchant,
    category: cat?.name ?? null,
    categoryGroup: parent?.name ?? cat?.name ?? null,
    cashReceipt: look.withReceipt.has(r.id),
    // 폰 알림으로 만든 임시 거래. 엑셀이 그 기간을 덮으면 사라진다
    provisional: r.source === "notify",
    // 메모 낱말로 붙는 태그. 없으면 칸 자체를 안 보낸다 (달력 한 달이 수백 줄이라)
    ...(((t) => (t.length ? { tags: t } : {}))(tagsOf(r.memo, look.tagRules))),
  };
}

/** 정기 결제 계산용 나간 돈 기록 (최근 약 2년). 전체 기간을 훑으므로 인스턴스에 10분 둔다 */
const RECURRING_DAYS = 760;
let recurringCache: { at: number; today: string; rows: { id: number; kind: string; status: string; date: string; merchant: string; amount: number; categoryId: number | null }[] } | null = null;
export const forgetRecurring = () => {
  recurringCache = null;
};

const seoulToday = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const seoulNowTime = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(11, 19);

export const ledgerServer: ServerModule = {
  id: "ledger",
  createApi: createLedgerApi,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}:\d{2}$/;
const KINDS = new Set(["expense", "income", "transfer"]);
const isStr = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** 브라우저가 보낸 거래 목록을 검사한다. 이상한 값은 통째로 거절 */
function readImportPayload(body: unknown): ImportPayload {
  const b = body as Partial<ImportPayload> | null;
  const bad = (what: string) => new ImportError(`가져오기 데이터가 올바르지 않아요 (${what})`);
  if (!b || !isStr(b.source, 50) || !isStr(b.fileName, 300) || !isStr(b.fileSha256, 64) || !Array.isArray(b.rows)) throw bad("형식");
  if (b.rows.length > 1000) throw bad("한 번에 보낼 수 있는 행 수(1,000)를 넘음");
  b.rows.forEach((r: ImportRow, i) => {
    const ok =
      r &&
      KINDS.has(r.kind) &&
      isStr(r.date) &&
      DATE.test(r.date) &&
      (r.time === null || (isStr(r.time) && TIME.test(r.time))) &&
      isStr(r.merchant) &&
      isInt(r.amount) &&
      isStr(r.paymentMethod) &&
      isStr(r.dedupeKey, 64) &&
      (r.memo === undefined || isStr(r.memo)) &&
      (r.excludeReason === undefined || isStr(r.excludeReason, 40)) &&
      (r.sourceCategory === undefined ||
        (isStr(r.sourceCategory.major, 100) && (r.sourceCategory.minor === undefined || isStr(r.sourceCategory.minor, 100))));
    if (!ok) throw bad(`${i + 1}번째 행`);
  });
  const skipped = Array.isArray(b.skipped) ? b.skipped.slice(0, 1000) : [];
  const snapshot = b.snapshot && typeof b.snapshot === "object" ? (b.snapshot as Snapshot) : null;
  if (b.asOf !== undefined && !(isStr(b.asOf) && DATE.test(b.asOf))) throw bad("기준일");
  if (b.batchId !== undefined && !isInt(b.batchId)) throw bad("기록 id");
  return {
    source: b.source,
    fileName: b.fileName,
    fileSha256: b.fileSha256,
    rows: b.rows,
    skipped,
    snapshot,
    ...(b.asOf ? { asOf: b.asOf } : {}),
    ...(b.batchId ? { batchId: b.batchId } : {}),
  };
}

function readReceipts(body: unknown): { receipts: CashReceipt[]; skipped: { row: string; reason: string }[] } {
  const b = body as { receipts?: CashReceipt[]; skipped?: { row: string; reason: string }[] } | null;
  if (!b || !Array.isArray(b.receipts) || b.receipts.length > 10_000) throw new ImportError("현금영수증 데이터가 올바르지 않아요");
  for (const r of b.receipts) {
    const ok =
      r &&
      isStr(r.approvalNo, 50) &&
      r.approvalNo.length > 0 &&
      isStr(r.date) &&
      DATE.test(r.date) &&
      (r.time === null || (isStr(r.time) && TIME.test(r.time))) &&
      isStr(r.merchant) &&
      isInt(r.amount) &&
      (r.kind === "general" || r.kind === "culture");
    if (!ok) throw new ImportError("현금영수증 데이터가 올바르지 않아요");
  }
  return { receipts: b.receipts, skipped: Array.isArray(b.skipped) ? b.skipped.slice(0, 1000) : [] };
}

function createLedgerApi() {
  const api = new Hono<AppEnv>();

  // 카테고리 목록 개편을 아직 적용하지 않은 DB 면 먼저 적용 (recategorize.ts)
  api.use(async (c, next) => {
    await ensureCategoryVersion(c.env.DB);
    await next();
  });

  /** 탭 배지용: 확인 필요 건수 (화면을 옮길 때마다 불려서 인덱스로 센다) */
  api.get("/", async (c) => {
    const counts = await c.env.DB.prepare("SELECT count(*) AS review FROM ledger_transactions WHERE status = 'review'").first<{ review: number }>();
    return c.json({
      review: counts!.review,
      importSources: Object.entries(importSources).map(([id, s]) => ({ id, label: s.label })),
    });
  });

  /**
   * 간편결제 중복 — 네이버페이로 카드를 긁으면 두 줄로 들어오는 것 (importers/simple-pay.ts).
   * 보기는 GET, 지우기는 POST. 지울 때도 서버가 다시 찾아 겹치는 것만 지운다.
   */
  api.get("/duplicates", async (c) => c.json({ pairs: await findSimplePayDupes(c.env.DB) }));

  api.post("/duplicates/remove", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((v): v is number => Number.isInteger(v)).slice(0, 500) : [];
    return c.json(await removeSimplePayDupes(c.env.DB, ids));
  });

  api.get("/imports", async (c) =>
    c.json(
      (
        await c.env.DB.prepare(
          `SELECT id, source, file_name AS fileName, period_from AS periodFrom, period_to AS periodTo,
                  total_rows AS totalRows, inserted, duplicates, excluded, skipped, imported_at AS importedAt
           FROM ledger_import_batches ORDER BY id DESC LIMIT 20`,
        ).all()
      ).results,
    ),
  );

  // 원본 파일은 브라우저에서 읽고, 여기로는 거래 목록(JSON)만 온다.
  // 무료 플랜 CPU 제한(요청당 10ms) 때문에 브라우저가 500건씩 나눠 보낸다 (web/api.ts)
  const upload = bodyLimit({ maxSize: 2 * 1024 * 1024 });

  async function plan(body: unknown, db: AppEnv["Bindings"]["DB"]) {
    const payload = readImportPayload(body);
    const source = importSources[payload.source];
    if (!source) throw new ImportError("지원하지 않는 가져오기 소스예요.");
    return { payload, plan: await planImport(db, { id: payload.source, ...source }, payload) };
  }

  const snapshotInfo = (s: Snapshot | null) =>
    s && { loans: s.loans.length, assets: s.assets.length, investments: s.investments.length, creditScore: s.creditScore };

  api.post("/imports/preview", upload, async (c) => {
    const { payload, plan: p } = await plan(await c.req.json(), c.env.DB);
    return c.json({ ...p.summary, snapshot: snapshotInfo(payload.snapshot) });
  });

  api.post("/imports", upload, async (c) => {
    const { payload, plan: p } = await plan(await c.req.json(), c.env.DB);
    const result = await commitImport(c.env.DB, p, { name: payload.fileName, sha256: payload.fileSha256 }, payload.batchId);
    forgetDisplayNames();
    forgetRecurring();
    const asOf = payload.asOf ?? p.summary.period?.to ?? new Date().toISOString().slice(0, 10);
    if (payload.snapshot) await saveSnapshot(c.env.DB, asOf, payload.snapshot);
    return c.json({ ...p.summary, ...result, snapshot: snapshotInfo(payload.snapshot) });
  });

  /**
   * 폰 알림 원문 받기 (아이폰 단축어 → 여기).
   *
   * **해석하지 않는다.** 앱마다 문구가 달라서, 실제로 어떤 모양으로 오는지 쌓아 보고 나서
   * 파서를 짠다. 거래가 아닌 알림(광고·잔액 안내)도 버리지 않고 둔다 — 무엇을 걸러야
   * 하는지 알려면 그것들이 필요하다.
   *
   * 인증은 가져오기 키(X-Import-Token). 단축어는 OTP 를 칠 수 없다.
   */
  api.post("/notify", async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    // 글자 수를 자른다 — 알림 하나가 표를 다 차지하는 일이 없게
    const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
    const app = str(b?.app, 100);
    const title = str(b?.title, 300);
    const subtitle = str(b?.subtitle, 300);
    // 단축어에서 칸을 나누지 않고 한 덩어리(`text`)로 보냈을 때도 받아 둔다. 나눠 보내는
    // 쪽이 파싱에 낫지만, 설정이 어긋났다고 알림을 통째로 잃는 것보다는 뭉쳐서라도 남기는 게 낫다
    const body = str(b?.body, 2000) ?? str(b?.text, 2000);
    // 넷 다 비면 받을 게 없다. 단축어 설정이 잘못된 것이므로 조용히 넘기지 않는다.
    //
    // **무엇을 받았는지 같이 돌려준다.** 비는 이유가 여럿이라(수동 실행이라 알림이 없다 /
    // 본문 형식이 JSON 이 아니다 / 필드 이름이 다르다) 메시지만으로는 구분이 안 되고,
    // 폰에서 단축어를 고치는 쪽은 서버 로그를 볼 수 없다. 키 이름만 돌려주므로 값이 새지 않는다.
    if (!app && !title && !subtitle && !body) {
      return c.json(
        {
          error: "알림 내용이 비어 있어요.",
          받은형식: c.req.header("Content-Type") ?? "(없음)",
          본문해석: b === null ? "실패 — JSON 이 아니에요" : "성공",
          받은칸: b ? Object.keys(b) : [],
          필요한칸: ["app", "title", "subtitle", "body", "sentAt"],
        },
        400,
      );
    }
    const res = await c.env.DB.prepare(
      "INSERT INTO ledger_notifications (sent_at, app, title, subtitle, body) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(str(b?.sentAt, 100), app, title, subtitle, body)
      .first<{ id: number }>();
    // 오래된 건 버린다. 원문은 파서를 다듬는 동안만 쓸모가 있어서 쌓아 둘 이유가 없다
    await c.env.DB.prepare(
      "DELETE FROM ledger_notifications WHERE id <= (SELECT MAX(id) - 1000 FROM ledger_notifications)",
    ).run();

    /**
     * 읽을 수 있으면 **임시 거래**로 넣는다 (`source = 'notify'`).
     *
     * 읽지 못해도 오류로 치지 않는다 — 광고·잔액 안내가 훨씬 많고, 단축어 쪽에서 그걸
     * 실패로 보면 쓸데없이 재시도한다. 원문은 어차피 위에 남아 있어서 나중에 파서를
     * 고쳐 다시 볼 수 있다.
     */
    const parsed = parseNotification({ app, title, subtitle, body }, seoulToday(), { sentAt: str(b?.sentAt, 100), nowTime: seoulNowTime() });
    if (!parsed) return c.json({ ok: true, id: res?.id ?? null, 거래: null });

    // 같은 알림이 두 번 와도 거래가 둘이 되지 않게. 소스가 달라 엑셀 행과는 겹치지 않는다
    const key = await sha256(["notify", parsed.date, parsed.time, parsed.amount, parsed.merchant].join("\u001f"));
    // 아는 만큼 분류를 채운다 (사용자가 앱알림 줄에서 고른 것 → 가져오기 규칙 → 가맹점 이름 규칙). notify-category.ts
    const categoryId = await notifyCategory(c.env.DB, parsed);
    const tx = await c.env.DB.prepare(
      `INSERT INTO ledger_transactions (kind, status, date, time, merchant, amount, payment_method, source, dedupe_key, category_id, category_source)
       VALUES (?, 'active', ?, ?, ?, ?, ?, 'notify', ?, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
    )
      .bind(parsed.kind, parsed.date, parsed.time, parsed.merchant, parsed.amount, parsed.paymentMethod, key, categoryId, categoryId === null ? null : "rule")
      .first<{ id: number }>();
    if (tx) {
      await c.env.DB.prepare("UPDATE ledger_notifications SET parsed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .bind(res?.id ?? 0)
        .run();
      forgetRecurring(); // 정기 결제 계산이 들고 있는 10분 캐시를 비운다
    }
    return c.json({ ok: true, id: res?.id ?? null, 거래: tx ? { id: tx.id, ...parsed, categoryId } : "이미 있음" });
  });

  /**
   * 알림 화면 한 번에 (notify-status.ts).
   *
   * 폰 알림이 **오고 있는지**, 그걸로 만든 임시 거래가 무엇인지, 집 맥북의 자동 가져오기가
   * 살아 있는지를 한 왕복으로 준다. 임시 거래는 엑셀이 덮으면 사라지는 것들이라 많아야
   * 몇 주 치다(부분 인덱스로 그것만 읽는다).
   */
  api.get("/notify/overview", async (c) => {
    const [recent, provisional, sync, look] = await Promise.all([
      recentNotifications(c.env.DB),
      // ORDER BY 는 date 만 — time 까지 넣으면 SQLite 가 부분 인덱스를 버리고 표 전체를 훑는다 (7,000행). 나머지는 JS 에서 정렬
      c.env.DB.prepare(`SELECT ${TX_COLUMNS} FROM ledger_transactions WHERE source = 'notify' ORDER BY date DESC LIMIT 200`).all<TxRow>(),
      readSyncStatus(c.env.DB),
      lookups(c.env.DB),
    ]);
    const last = recent[0];
    return c.json({
      status: { lastAt: last?.receivedAt ?? null, lastApp: last?.app ?? null, pending: provisional.results.length },
      sync,
      provisional: provisional.results
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.time ?? "").localeCompare(String(a.time ?? "")) || b.id - a.id)
        .map((r) => present(r, look)),
      recent,
    });
  });

  /**
   * 집 맥북 ledger-sync 의 생존 보고 (10분마다). 가져오기 키로 들어온다 (host auth.ts IMPORT_PATHS).
   *
   * **데이터 버전은 올리지 않는다.** 보고는 설정 한 행을 덮어쓸 뿐 가계부 내용은 그대로인데,
   * 버전이 오르면 화면 캐시와 전체 훑기 캐시(rev-cache)가 10분마다 깨진다 — 그러면 "바뀐 게
   * 없으면 다시 만들지 않는다" 는 설계가 통째로 무너진다. 그래서 알림 화면은 이 값을 캐시
   * 없이 매번 읽는다 (web/api.ts notifyOverview).
   */
  api.post("/sync-status", async (c) => {
    const report = readSyncReport(await c.req.json().catch(() => null));
    if (!report) return c.json({ error: "ok(true/false) 가 필요해요" }, 400);
    const status = await recordSyncReport(c.env.DB, report);
    c.set("skipRevBump", true);
    return c.json({ ok: true, status });
  });

  /**
   * 메일에서 엑셀 자동으로 가져오기 설정 (mail-config.ts).
   *
   * 쓰기지만 **데이터 버전은 올리지 않는다** — 가계부 내용이 아니라 살림이라, 설정을 만질 때마다
   * 화면 캐시와 전체 훑기 캐시가 깨지면 손해만 본다.
   */
  api.get("/mail-config", async (c) => c.json(await loadMailConfig(c.env.DB, c.env.SETTINGS_KEY)));

  api.put("/mail-config", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "설정이 필요해요" }, 400);
    c.set("skipRevBump", true);
    try {
      return c.json(await saveMailConfig(c.env.DB, body, c.env.SETTINGS_KEY));
    } catch (e) {
      if (e instanceof MailConfigError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  /** 설치할 때 한 번 쓰는 연결 코드. 평문 코드는 이 응답에만 나온다 */
  api.post("/mail-config/link", async (c) => {
    c.set("skipRevBump", true);
    return c.json(await makeMailLink(c.env.DB));
  });

  /**
   * 도구가 설정을 받아 가는 자리. **로그인도 키도 없이 열려 있고, 코드 자체가 열쇠다**
   * (auth.ts 의 PUBLIC_PATHS). 코드는 10분·한 번이고 쓰는 즉시 사라진다 — 가져오기 키의
   * 범위를 넓히지 않으려고 이렇게 했다.
   */
  api.get("/mail-config/claim", async (c) => {
    c.set("skipRevBump", true);
    try {
      return c.json(await claimMailLink(c.env.DB, c.req.query("code") ?? "", c.env.SETTINGS_KEY, c.env.IMPORT_TOKEN));
    } catch (e) {
      if (e instanceof MailConfigError) return c.json({ error: e.message }, 403);
      throw e;
    }
  });

  api.get("/snapshot/latest", async (c) => c.json(await latestSnapshot(c.env.DB)));

  /** 기간 안의 기록 (확인 필요한 이체 제외). 시간 없는 기록이 그날 맨 앞에 온다 */
  api.get("/transactions", async (c) => {
    const from = c.req.query("from") ?? "";
    const to = c.req.query("to") ?? "";
    if (!DATE.test(from) || !DATE.test(to)) return c.json({ error: "from, to 날짜가 필요해요" }, 400);
    const [rows, look] = await Promise.all([
      c.env.DB.prepare(
        `SELECT ${TX_COLUMNS} FROM ledger_transactions
         WHERE status = 'active' AND date BETWEEN ? AND ?
         ORDER BY date, time IS NOT NULL, time, id`,
      )
        .bind(from, to)
        .all<TxRow>(),
      lookups(c.env.DB),
    ]);
    return c.json(rows.results.map((r) => present(r, look)));
  });

  /**
   * 가맹점 이름(원래 이름·묶은 이름), 메모(상세 포함), 카테고리 이름('미분류' 포함)에서 찾는다. 숫자만 넣으면 금액도 본다.
   * 띄어쓰기로 여러 말을 넣으면 모두 맞는 것만 (AND).
   * LIKE '%…%' 라 전체를 한 번 훑는다 (7,000건 ≈ 7천 행). 화면은 입력할 때마다가 아니라 Enter 때만 부른다.
   */
  api.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim().slice(0, 50);
    if (!q) return c.json({ results: [], more: false });
    const look = await lookups(c.env.DB);
    // 띄어쓰기로 나눈 말은 모두 맞아야 한다 (AND). 말마다 가게·메모·금액·카테고리 중 하나에 맞으면 된다
    const terms = [...new Set(q.split(/\s+/).filter(Boolean))].slice(0, 5);
    const where: string[] = [];
    const binds: SqlValue[] = [];
    for (const term of terms) {
      const lower = term.toLowerCase();
      // 묶은 이름으로 찾으면 원래 이름이 달라도 나오게 (예: 오늘의집 → 버킷플레이스)
      const aliases = [...look.merchants].filter(([raw, shown]) => shown.toLowerCase().includes(lower) && !raw.toLowerCase().includes(lower)).map(([raw]) => raw);
      const digits = term.replace(/[,원]/g, "");
      const amount = /^\d{3,10}$/.test(digits) ? Number(digits) : -1;
      const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      // 카테고리 이름 (대분류가 맞으면 그 소분류까지). '미분류'는 카테고리 없는 지출·수입
      const catHit = new Set<number>();
      for (const cat of look.byId.values()) if (cat.name.toLowerCase().includes(lower)) catHit.add(cat.id);
      for (const cat of look.byId.values()) if (cat.parentId !== null && catHit.has(cat.parentId)) catHit.add(cat.id);
      // 태그: '#반려동물' 은 태그만, 그냥 '반려동물' 은 다른 조건과 함께 본다.
      // 태그는 저장하지 않으므로 그 태그를 만드는 낱말들로 메모를 찾는다
      const tagWords = wordsForTag(look.tagRules, term.replace(/^#/, ""));
      const tagLikes = tagWords.map((w) => `%${w.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
      const tagCond = tagWords.map(() => `memo LIKE ? ESCAPE '\\'`).join(" OR ");
      if (term.startsWith("#")) {
        // 없는 태그를 찾으면 결과도 없어야 한다 (가게 이름에 우연히 맞는 걸 내놓지 않는다)
        where.push(tagCond ? `(${tagCond})` : "0 = 1");
        binds.push(...tagLikes);
        continue;
      }
      where.push(
        `(merchant LIKE ? ESCAPE '\\' OR memo LIKE ? ESCAPE '\\' OR abs(amount) = ? OR merchant IN (SELECT value FROM json_each(?))
          OR category_id IN (SELECT value FROM json_each(?)) OR (? = 1 AND category_id IS NULL AND kind <> 'transfer')${tagCond ? ` OR ${tagCond}` : ""})`,
      );
      binds.push(like, like, amount, json(aliases), json([...catHit]), term === "미분류" ? 1 : 0, ...tagLikes);
    }
    const rows = await c.env.DB.prepare(
      `SELECT ${TX_COLUMNS} FROM ledger_transactions
       WHERE status = 'active' AND ${where.join(" AND ")}
       ORDER BY date DESC, time DESC, id DESC
       LIMIT ${SEARCH_LIMIT + 1}`,
    )
      .bind(...binds)
      .all<TxRow>();
    const found = rows.results.slice(0, SEARCH_LIMIT);
    /**
     * 취소된 결제에 취소선을 그으려면 **짝이 되는 환불 줄**이 있어야 하는데, 환불 줄에는 메모가
     * 없어서 검색에 안 걸린다. 찾은 줄의 가게·기간으로 환불만 따로 불러와 같이 보낸다
     * (화면이 `pairCancels` 로 짝을 맞춘다. 2026-11-12 사용자 요청).
     */
    const cancels = found.length ? await refundsNear(c.env.DB, found) : [];
    return c.json({
      results: found.map((r) => present(r, look)),
      more: rows.results.length > SEARCH_LIMIT,
      cancels: cancels.map((r) => present(r, look)),
    });
  });

  /**
   * 거래 한 건 고치기: 메모(첫 줄)·상세 메모, 카테고리(기존 id / 새로 만들 "대분류 > 소분류" / null).
   * 고른 카테고리는 manual 로 남는다. 메모와 상세는 memo 칸 하나에 저장한다 (memo.ts)
   */
  api.patch("/transactions/:id", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { memo?: unknown; note?: unknown; categoryId?: unknown; newCategory?: unknown } | null;
    const hasMemo = body !== null && ("memo" in body || "note" in body);
    const hasCategory = body !== null && ("categoryId" in body || "newCategory" in body);
    const textOrNull = (v: unknown) => v === undefined || v === null || typeof v === "string";
    if (
      !body ||
      (!hasMemo && !hasCategory) ||
      !textOrNull(body.memo) ||
      !textOrNull(body.note) ||
      ("categoryId" in body && body.categoryId !== null && !isInt(body.categoryId)) ||
      ("newCategory" in body && !(isStr(body.newCategory, 70) && body.newCategory.trim()))
    ) {
      return c.json({ error: "memo, note 또는 categoryId 가 필요해요" }, 400);
    }
    const id = Number(c.req.param("id")) || 0;
    const existing = await c.env.DB.prepare("SELECT memo, kind, merchant, source, category_id AS categoryId FROM ledger_transactions WHERE id = ?")
      .bind(id)
      .first<{ memo: string | null; kind: "expense" | "income" | "transfer"; merchant: string; source: string; categoryId: number | null }>();
    if (!existing) return c.json({ error: "기록을 찾을 수 없어요" }, 404);

    const out: { memo?: string | null; note?: string | null; categoryId?: number | null; tags?: string[] } = {};
    if (hasMemo) {
      // 보낸 쪽만 바꾸고 나머지는 그대로
      const before = splitMemo(existing.memo);
      const stored = joinMemo(
        "memo" in body ? ((body.memo as string | null) ?? null) : before.memo,
        "note" in body ? ((body.note as string | null) ?? null) : before.note,
      );
      Object.assign(out, splitMemo(stored));
      forgetMemoUses();
      await c.env.DB.prepare(`UPDATE ledger_transactions SET memo = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .bind(stored, id)
        .run();
      // 태그는 메모에서 뽑으므로 메모가 바뀌면 같이 바뀐다 — 화면이 다시 안 받아도 되게 붙여 준다
      out.tags = tagsOf(stored, await loadTagRules(c.env.DB));
    }
    if (hasCategory) {
      out.categoryId = typeof body.newCategory === "string" ? await ensureCategoryPath(c.env.DB, body.newCategory) : ((body.categoryId as number | null) ?? null);
      await c.env.DB.prepare(
        `UPDATE ledger_transactions SET category_id = ?, category_source = 'manual', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
        .bind(out.categoryId, id)
        .run();
      // 앱알림 줄에서 고른 분류는 같은 가맹점 이름의 다음 알림에도 쓴다 (엑셀 이름과 달라 가져오기 규칙으로는 못 맞춘다)
      if (existing.source === "notify") await rememberNotifyCategory(c.env.DB, existing.merchant, out.categoryId);
    }
    return c.json(out);
  });

  /** 메모 자동완성용: 지금까지 쓴 메모 (원래 가게 이름·금액·횟수) */
  api.get("/memos", async (c) => c.json(await memoUses(c.env.DB)));

  /**
   * 예전 구글 캘린더 지출 기록의 상세 메모를 거래 상세 메모로 (notes-import.ts).
   * preview = 몇 건 맞는지만, apply = 넣기. 이미 상세 메모가 있는 거래는 안 건드린다.
   */
  api.post("/notes/preview", async (c) => {
    const items = parseNoteItems(await c.req.json());
    const { matches, already, unmatched } = matchNotes(items, await loadNoteTxs(c.env.DB, items));
    return c.json({
      matched: matches.length,
      already: already.length,
      unmatched: unmatched.length,
      samples: matches.slice(-5).map(({ item, tx }) => ({ date: tx.date, amount: item.amount, merchant: tx.merchant, note: item.note.split("\n")[0] })),
    });
  });

  api.post("/notes/apply", async (c) => {
    const items = parseNoteItems(await c.req.json());
    const { matches } = matchNotes(items, await loadNoteTxs(c.env.DB, items));
    const applied = await applyNotes(c.env.DB, matches);
    forgetMemoUses();
    return c.json({ applied });
  });

  /** 검색 자동완성: 가게 이름(보여줄 이름)·한 줄 메모와 횟수. 둘 다 인스턴스 캐시라 보통 D1 읽기 없음 */
  api.get("/search/terms", async (c) => {
    const [names, uses] = await Promise.all([loadNames(c.env.DB), memoUses(c.env.DB)]);
    const memos = new Map<string, number>();
    for (const u of uses) memos.set(u.memo, (memos.get(u.memo) ?? 0) + u.count);
    const top = (m: Map<string, number>) =>
      [...m]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3000)
        .map(([text, n]) => ({ text, n }));
    return c.json({ merchants: top(names.counts), memos: top(memos) });
  });

  /** 메모가 없는 같은 가게 결제 수 (메모 저장 뒤 "한 번에 넣을까?" 안내용) */
  api.get("/memos/similar", async (c) => {
    const merchant = c.req.query("merchant") ?? "";
    const amount = Number(c.req.query("amount"));
    if (!merchant || merchant.length > 200 || !Number.isInteger(amount)) return c.json({ error: "merchant, amount 가 필요해요" }, 400);
    return c.json(await similarWithoutMemo(c.env.DB, merchant, amount));
  });

  /** 메모 없는 같은 가게(·같은 금액) 결제에 한 번에 메모 넣기. remember 면 다음 가져오기부터도 */
  api.post("/memos/apply", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { merchant?: unknown; amount?: unknown; memo?: unknown; remember?: unknown } | null;
    if (
      !body ||
      !isStr(body.merchant, 200) ||
      !body.merchant ||
      !(body.amount === null || isInt(body.amount)) ||
      !isStr(body.memo, 200) ||
      !body.memo.trim()
    ) {
      return c.json({ error: "merchant, amount, memo 가 필요해요" }, 400);
    }
    return c.json(await applyMemo(c.env.DB, { merchant: body.merchant, amount: body.amount as number | null, memo: body.memo, remember: body.remember === true }));
  });

  /** 사용자가 직접 고르지 않은 같은 가게 결제 중 카테고리가 다른 것 수 (카테고리 바꾼 뒤 "한 번에 바꿀까?" 안내용) */
  api.get("/categories/similar", async (c) => {
    const merchant = c.req.query("merchant") ?? "";
    const amount = Number(c.req.query("amount"));
    const categoryId = Number(c.req.query("categoryId"));
    if (!merchant || merchant.length > 200 || !Number.isInteger(amount) || !Number.isInteger(categoryId)) return c.json({ error: "merchant, amount, categoryId 가 필요해요" }, 400);
    return c.json(await similarCategory(c.env.DB, merchant, amount, categoryId));
  });

  /** 같은 가게(·같은 금액) 결제 카테고리를 한 번에. remember 면 다음 가져오기부터도 */
  api.post("/categories/apply", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { merchant?: unknown; amount?: unknown; categoryId?: unknown; remember?: unknown } | null;
    if (!body || !isStr(body.merchant, 200) || !body.merchant || !(body.amount === null || isInt(body.amount)) || !isInt(body.categoryId)) {
      return c.json({ error: "merchant, amount, categoryId 가 필요해요" }, 400);
    }
    return c.json(await applyCategory(c.env.DB, { merchant: body.merchant, amount: body.amount as number | null, categoryId: body.categoryId, remember: body.remember === true }));
  });

  /**
   * 정기 결제: 같은 이름으로 거의 같은 간격마다 나간 돈 (지출·이체). 다음 예상일·금액 변화·안 나감 표시.
   * 설정 recurring.ignore.<이름> = 정기 아님, recurring.include.<이름> = 두 번만 나왔어도 정기로 (예전에 표시한 것만. 두 번짜리 후보 목록은 2026-10-01 없앰 — 사용자: 2회로는 정기 아님)
   */
  api.get("/recurring", async (c) => {
    const today = seoulToday();
    if (!recurringCache || Date.now() - recurringCache.at > NAMES_TTL_MS || recurringCache.today !== today) {
      const from = new Date(Date.now() - RECURRING_DAYS * 86_400_000).toISOString().slice(0, 10);
      // 여기는 D1 캐시(rev-cache)를 쓰지 않는다. 이득이 가장 작고(4.9천→61행) 날짜 창이
      // 날마다 밀려서 이름이 계속 바뀌는 데다, status·category_id 까지 읽어서 '카테고리 이행'
      // 같은 GET 중 변경에 물릴 여지가 있다. 인스턴스 10분 캐시만 유지한다.
      const rows = await c.env.DB.prepare(
        `SELECT id, kind, status, date, merchant, amount, category_id AS categoryId FROM ledger_transactions
         WHERE date >= ? AND amount <> 0 AND kind IN ('expense', 'transfer', 'income') AND status IN ('active', 'review')`,
      )
        .bind(from)
        .all<{ id: number; kind: string; status: string; date: string; merchant: string; amount: number; categoryId: number | null }>();
      recurringCache = { at: Date.now(), today, rows: rows.results };
    }
    const [look, settings] = await Promise.all([
      lookups(c.env.DB),
      c.env.DB.prepare("SELECT key, value FROM ledger_settings WHERE key LIKE 'recurring.%'").all<{ key: string; value: string }>(),
    ]);
    const keysOf = (prefix: string) => new Set(settings.results.filter((r) => r.key.startsWith(prefix)).map((r) => r.key.slice(prefix.length)));
    const ignore = keysOf("recurring.ignore.");
    const include = keysOf("recurring.include.");
    const valuesOf = (prefix: string) => new Map(settings.results.filter((r) => r.key.startsWith(prefix)).map((r) => [r.key.slice(prefix.length), r.value]));
    const memos = valuesOf("recurring.memo.");
    // 이름이 바뀐 같은 정기 결제 합치기 (recurring.alias.<다른 이름> = <합칠 이름>)
    const aliases = valuesOf("recurring.alias.");
    const label = (id: number | null) => {
      const cat = id !== null ? look.byId.get(id) : undefined;
      const parent = cat?.parentId != null ? look.byId.get(cat.parentId) : undefined;
      return cat ? (parent ? `${parent.name} › ${cat.name}` : cat.name) : null;
    };
    const groupOf = (id: number | null) => {
      const cat = id !== null ? look.byId.get(id) : undefined;
      return cat ? (cat.parentId != null ? (look.byId.get(cat.parentId)?.name ?? null) : cat.name) : null;
    };
    // 나간 돈(지출·보낸 이체)과 들어온 돈(수입·받은 이체)을 따로 본다. 들어온 돈은 키 앞에 '+' (급여 등)
    // 합치기는 '합칠 이름'이 예전(원래 이름 기준) 키로 저장돼 있을 수 있다 → 지금 키(화면 이름 기준)로 고친다
    const toNewBase = new Map<string, string>();
    for (const r of recurringCache.rows) toNewBase.set(counterpartyKey(r.merchant), counterpartyKey(look.merchants.get(r.merchant) ?? r.merchant));
    const aliasFixes: { key: string; value: string }[] = [];
    for (const [from, into] of aliases) {
      const fixed = toNewBase.get(into);
      if (fixed && fixed !== into) {
        aliases.set(from, fixed);
        aliasFixes.push({ key: `recurring.alias.${from}`, value: fixed });
      }
    }
    const inputs: RecurringInput[] = [];
    // 예전(원래 이름 기준) 키 → 지금 키. 2026-10-01 화면 이름으로 묶게 바꾸면서 예전 키에 저장된 메모·정기 아님이 안 보이던 것을 옮긴다
    const renamed = new Map<string, string>();
    for (const r of recurringCache.rows) {
      const out = r.amount < 0 && r.kind !== "income";
      const inc = r.amount > 0 && r.kind !== "expense";
      if (!out && !inc) continue; // 지출 환불·음수 수입은 빼고
      if (inc && r.amount < SMALL_INCOME_LIMIT) continue; // 몇십 원짜리 이자·리워드는 정기로 안 본다 (통계에서만)
      // 화면 이름(띄어쓰기·밑줄·괄호·법인 표기만 다른 이름을 합친 것)으로 묶는다. 뱅크샐러드가 달마다 표기를 바꿔 찍어도 한 정기 결제로
      const name = look.merchants.get(r.merchant) ?? r.merchant;
      const base = counterpartyKey(name);
      const rawBase = counterpartyKey(r.merchant);
      const target = aliases.get(base) ?? aliases.get(rawBase);
      const key = (inc ? "+" : "") + (target ?? base);
      const oldKey = (inc ? "+" : "") + (aliases.get(rawBase) ?? rawBase);
      if (oldKey !== key) renamed.set(oldKey, key);
      inputs.push({
        id: r.id,
        key,
        name,
        kind: r.kind === "transfer" ? "transfer" : r.kind === "income" ? "income" : "expense",
        direction: inc ? "in" : "out",
        review: r.status === "review",
        date: r.date,
        amount: Math.abs(r.amount),
        category: label(r.categoryId),
        group: groupOf(r.categoryId),
        merged: target !== undefined && target !== base,
      });
    }
    const moves = moveLegacySettings(renamed, { memos, ignore, include });
    if (moves.length || aliasFixes.length) {
      await c.env.DB.batch([
        ...moves.flatMap(({ from, to, value }) => [
          c.env.DB.prepare("INSERT INTO ledger_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING").bind(to, value),
          c.env.DB.prepare("DELETE FROM ledger_settings WHERE key = ?").bind(from),
        ]),
        ...aliasFixes.map(({ key, value }) => c.env.DB.prepare("UPDATE ledger_settings SET value = ? WHERE key = ?").bind(value, key)),
      ]);
    }
    const items = detectRecurring(inputs, today, { ignore, include, memos });

    /**
     * 직접 등록한 것(연 1회처럼 자동으로는 안 잡히는 것)을 뒤에 붙인다.
     *
     * 같은 이름이 실제 내역에서 잡히기 시작하면 **찾아낸 쪽이 이긴다** — 그쪽은 실제 금액과
     * 지난 기록을 들고 있다. 등록해 둔 건 조용히 가려지고, 지우는 건 사용자 몫이다.
     */
    for (const [name, raw] of valuesOf(PLAN_PREFIX)) {
      const parsed = parsePlan(name, raw);
      if (!parsed) continue;
      const key = (parsed.direction === "in" ? "+" : "") + counterpartyKey(name);
      if (items.some((i) => i.key === key)) continue;
      items.push(planToRecurring(parsed, today, key, label(parsed.categoryId)));
    }
    items.sort((a, b) => b.monthly - a.monthly);

    const names = new Map(inputs.map((r) => [r.key, r.name]));
    // 합치기에서 고를 수 있는 이름들 (최근 2년 나간 돈, 많이 나온 순)
    const counts = new Map<string, number>();
    for (const r of recurringCache.rows) {
      if (r.amount >= 0) continue;
      const k = counterpartyKey(look.merchants.get(r.merchant) ?? r.merchant);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return c.json({
      today,
      items: items.map((i) => ({ ...i, aliases: [...aliases].filter(([, into]) => into === i.key).map(([from]) => from) })),
      names: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 500).map(([key]) => key),
      ignored: [...ignore].map((key) => ({ key, name: names.get(key) ?? key })),
    });
  });

  api.get("/settings", async (c) => {
    const rows = (await c.env.DB.prepare("SELECT key, value FROM ledger_settings").all<{ key: string; value: string }>()).results;
    return c.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  });

  /** 설정 하나 저장 (value 가 null 이면 삭제) */
  api.put("/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown; value?: unknown } | null;
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!key || key.length > 200 || (body!.value !== null && typeof body!.value !== "string") || String(body!.value ?? "").length > 200) {
      return c.json({ error: "key, value 가 필요해요" }, 400);
    }
    if (body!.value === null) await c.env.DB.prepare("DELETE FROM ledger_settings WHERE key = ?").bind(key).run();
    else
      await c.env.DB.prepare(
        `INSERT INTO ledger_settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
        .bind(key, body!.value as string)
        .run();
    return c.json({ ok: true });
  });

  async function planReceipts(body: unknown, db: AppEnv["Bindings"]["DB"]) {
    const { receipts, skipped } = readReceipts(body);
    const plan = await planCashReceipts(db, receipts);
    const count = (o: PlannedReceipt["outcome"]) => plan.filter((p) => p.outcome === o).length;
    const summary = {
      total: receipts.length,
      amount: receipts.reduce((s, r) => s + r.amount, 0),
      duplicates: count("duplicate"),
      existing: count("existing"),
      added: count("added"),
      cancelled: count("cancelled"),
      skipped,
      rows: plan
        .filter((p) => p.outcome !== "duplicate")
        .map((p) => ({ ...p.receipt, outcome: p.outcome, match: p.match ?? null })),
    };
    return { plan, summary };
  }

  api.post("/cash-receipts/preview", upload, async (c) => c.json((await planReceipts(await c.req.json(), c.env.DB)).summary));

  api.post("/cash-receipts", upload, async (c) => {
    const { plan, summary } = await planReceipts(await c.req.json(), c.env.DB);
    const saved = await commitCashReceipts(c.env.DB, plan);
    forgetDisplayNames();
    return c.json({ ...summary, ...saved });
  });

  api.get("/cash-receipts/summary", async (c) => {
    const year = c.req.query("year") ?? "";
    if (!/^\d{4}$/.test(year)) return c.json({ error: "year 가 필요해요" }, 400);
    return c.json(await cashReceiptSummary(c.env.DB, year));
  });

  /* ── 태그 규칙 (메모 낱말 → 태그 이름). tags.ts 참고 ── */

  api.get("/tags", async (c) => c.json({ rules: await loadTagRules(c.env.DB) }));

  api.post("/tags", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { word?: unknown; tag?: unknown } | null;
    const word = isStr(body?.word, WORD_MAX) ? body.word.trim() : "";
    const tag = isStr(body?.tag, TAG_MAX) ? body.tag.trim() : "";
    // 띄어쓰기가 든 태그 이름은 검색에서 두 낱말로 쪼개져 못 찾는다
    if (!word || !tag || /\s/.test(tag)) return c.json({ error: "찾을 말과 태그 이름(띄어쓰기 없이)이 필요해요" }, 400);
    const rules = await loadTagRules(c.env.DB);
    if (rules.length >= RULE_MAX && !rules.some((r) => r.word === word)) return c.json({ error: `규칙은 ${RULE_MAX}개까지예요` }, 400);
    await setTagRule(c.env.DB, word, tag);
    return c.json({ rules: await loadTagRules(c.env.DB) });
  });

  api.delete("/tags/:word", async (c) => {
    await deleteTagRule(c.env.DB, decodeURIComponent(c.req.param("word")).slice(0, WORD_MAX));
    return c.json({ rules: await loadTagRules(c.env.DB) });
  });

  api.get("/categories", async (c) => c.json(await listCategories(c.env.DB)));

  /** 카테고리 관리 화면: 목록 + 카테고리마다 걸린 거래·규칙 수 */
  api.get("/categories/manage", async (c) => c.json(await listCategoryUsage(c.env.DB)));

  /**
   * 고친 뒤에는 **캐시를 쓰지 않고** 다시 센 목록을 돌려준다 — 데이터 버전은 이 응답이 나간
   * 뒤에 오르므로(host/src/worker/app.ts), 캐시를 물으면 고치기 전 숫자가 나온다.
   */
  const manageResult = async (c: Context<AppEnv>, extra: Record<string, unknown> = {}) => {
    forgetRecurring(); // 정기 결제 계산이 카테고리 id 를 들고 있다
    return c.json({ ...extra, categories: await listCategoryUsage(c.env.DB, { cached: false }) });
  };

  api.patch("/categories/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    if (!isInt(id) || !body || !isStr(body.name, 30)) return c.json({ error: "name 이 필요해요" }, 400);
    await renameCategory(c.env.DB, id, body.name);
    return manageResult(c);
  });

  /** `into` 의 거래·규칙으로 옮기고 이 카테고리를 지운다 */
  api.post("/categories/:id/merge", async (c) => {
    const id = Number(c.req.param("id"));
    const body = (await c.req.json().catch(() => null)) as { into?: unknown } | null;
    if (!isInt(id) || !body || !isInt(body.into)) return c.json({ error: "into 가 필요해요" }, 400);
    const { moved } = await mergeCategory(c.env.DB, id, body.into);
    return manageResult(c, { moved });
  });

  /** 쓰는 데가 없을 때만 지운다 (거래·규칙이 걸려 있으면 거절) */
  api.delete("/categories/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!isInt(id)) return c.json({ error: "id 가 올바르지 않아요" }, 400);
    await deleteCategory(c.env.DB, id);
    return manageResult(c);
  });

  /** 드래그로 바꾼 순서. 한 부모 밑 형제 전부를 순서대로 보낸다 (대분류는 parentId 없음) */
  api.post("/categories/order", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { parentId?: unknown; ids?: unknown } | null;
    const ids = body?.ids;
    if (!body || !Array.isArray(ids) || !ids.every(isInt) || !(body.parentId == null || isInt(body.parentId))) {
      return c.json({ error: "ids 가 필요해요" }, 400);
    }
    await reorderCategories(c.env.DB, (body.parentId as number | null) ?? null, ids);
    return manageResult(c);
  });

  api.get("/review", async (c) => c.json(await listReviewGroups(c.env.DB)));

  api.post("/review/decide", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const actions = ["exclude", "transfer", "expense", "income"];
    if (!body || typeof body.counterparty !== "string" || !actions.includes(body.action as string)) {
      return c.json({ error: "counterparty, action 이 필요해요" }, 400);
    }
    const result = await decideReview(c.env.DB, {
      counterparty: body.counterparty,
      action: body.action as "exclude" | "transfer" | "expense" | "income",
      categoryId: typeof body.categoryId === "number" ? body.categoryId : null,
      ...(typeof body.newCategory === "string" ? { newCategory: body.newCategory } : {}),
    });
    forgetRecurring();
    return c.json(result);
  });

  api.onError((err, c) => {
    if (err instanceof ImportError) return c.json({ error: err.message }, 422);
    if (err instanceof CategoryError) return c.json({ error: err.message }, 400);
    if (err instanceof Error && err.message.startsWith("기록이 없거나")) return c.json({ error: err.message }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "요청 형식이 올바르지 않아요." }, 400);
    if (err instanceof ReadBudgetError) {
      console.error(err.message, c.req.path);
      return c.json({ error: "DB 를 너무 많이 읽어서 멈췄어요. 이 화면을 알려주세요." }, 503);
    }
    console.error(err);
    return c.json({ error: "서버 오류가 발생했어요." }, 500);
  });

  return api;
}

/**
 * 예전 키로 저장된 정기 결제 설정(메모·정기 아님·정기로 표시)을 지금 키로 옮길 목록. 지금 키에 이미 값이 있으면 그대로 둔다.
 * 넘긴 맵·집합도 지금 키로 고쳐 둔다 (이번 응답에 바로 보이게).
 */
export function moveLegacySettings(
  renamed: Map<string, string>,
  s: { memos: Map<string, string>; ignore: Set<string>; include: Set<string> },
): { from: string; to: string; value: string }[] {
  const moves: { from: string; to: string; value: string }[] = [];
  for (const [from, to] of renamed) {
    const memo = s.memos.get(from);
    if (memo !== undefined && !s.memos.has(to)) {
      s.memos.set(to, memo);
      moves.push({ from: `recurring.memo.${from}`, to: `recurring.memo.${to}`, value: memo });
    }
    for (const [set, prefix] of [
      [s.ignore, "recurring.ignore."],
      [s.include, "recurring.include."],
    ] as const) {
      if (set.has(from) && !set.has(to)) {
        set.add(to);
        moves.push({ from: prefix + from, to: prefix + to, value: "1" });
      }
    }
  }
  return moves;
}
