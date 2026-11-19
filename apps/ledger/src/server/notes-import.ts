/**
 * 예전에 구글 캘린더에 적던 지출 기록(`가게 0.89` + 상세 메모)의 상세 메모를 가계부 거래의 상세 메모로 옮긴다.
 * 같은 날·같은 금액의 지출(나간 이체 포함)에 맞추고, 없으면 하루 앞뒤에서 하나뿐일 때만. 이미 상세 메모가 있으면 안 건드린다.
 */
import { json, type SqlDb } from "@homebase/db";
import { joinMemo, splitMemo } from "./memo.ts";

export interface NoteItem {
  date: string;
  /** 원 (양수) */
  amount: number;
  /** 캘린더 제목에서 금액을 뗀 것 */
  title: string;
  note: string;
}

export interface NoteTx {
  id: number;
  date: string;
  time: string | null;
  /** 음수 */
  amount: number;
  merchant: string;
  memo: string | null;
}

export interface NoteMatch {
  item: NoteItem;
  tx: NoteTx;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_()㈜·.,-]|주식회사|\(주\)/g, "");
const near = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return Boolean(x && y && (x.includes(y) || y.includes(x)));
};
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** 맞추기 (순수 함수). already = 맞는 거래가 있지만 이미 상세 메모가 있는 것 */
export function matchNotes(items: NoteItem[], txs: NoteTx[]): { matches: NoteMatch[]; already: NoteItem[]; unmatched: NoteItem[] } {
  const byKey = new Map<string, NoteTx[]>();
  for (const t of txs) {
    const k = `${t.date}|${-t.amount}`;
    byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }
  const used = new Set<number>();
  const matches: NoteMatch[] = [];
  const already: NoteItem[] = [];
  const unmatched: NoteItem[] = [];
  const pick = (item: NoteItem, list: NoteTx[]) => {
    const free = list.filter((t) => !used.has(t.id));
    return free.find((t) => near(t.merchant, item.title)) ?? free.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""))[0];
  };
  for (const item of [...items].sort((a, b) => a.date.localeCompare(b.date))) {
    let tx = pick(item, byKey.get(`${item.date}|${item.amount}`) ?? []);
    if (!tx) {
      // 하루 앞뒤: 하나뿐일 때만 (밤늦게 결제·다음 날 적은 경우)
      const around = [-1, 1].flatMap((n) => (byKey.get(`${shift(item.date, n)}|${item.amount}`) ?? []).filter((t) => !used.has(t.id)));
      if (around.length === 1) tx = around[0];
    }
    if (!tx) {
      unmatched.push(item);
      continue;
    }
    used.add(tx.id);
    if (splitMemo(tx.memo).note) already.push(item);
    else matches.push({ item, tx });
  }
  return { matches, already, unmatched };
}

/** 받은 기록 기간의 지출·나간 이체 (기간 안만 읽는다, 날짜 인덱스) */
export async function loadNoteTxs(db: SqlDb, items: NoteItem[]): Promise<NoteTx[]> {
  if (!items.length) return [];
  const dates = items.map((i) => i.date).sort();
  const rows = await db
    .prepare(
      `SELECT id, date, time, amount, merchant, memo FROM ledger_transactions
       WHERE date BETWEEN ? AND ? AND amount < 0 AND kind IN ('expense', 'transfer') AND status = 'active'`,
    )
    .bind(shift(dates[0]!, -1), shift(dates[dates.length - 1]!, 1))
    .all<NoteTx>();
  return rows.results;
}

/** 여러 행의 memo 를 한 번에: 기본 키가 있는 임시 표에 넣고 키로 찾는다 (상관 서브쿼리 금지 규칙) */
export async function applyNotes(db: SqlDb, matches: NoteMatch[]): Promise<number> {
  if (!matches.length) return 0;
  const updates = matches.map(({ item, tx }) => ({ id: tx.id, memo: joinMemo(splitMemo(tx.memo).memo, item.note) }));
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS ledger_scratch_text (id INTEGER PRIMARY KEY, value TEXT)"),
    db.prepare("DELETE FROM ledger_scratch_text"),
    db.prepare("INSERT INTO ledger_scratch_text (id, value) SELECT value ->> 'id', value ->> 'memo' FROM json_each(?)").bind(json(updates)),
    db.prepare(
      "UPDATE ledger_transactions SET memo = (SELECT s.value FROM ledger_scratch_text s WHERE s.id = ledger_transactions.id) WHERE id IN (SELECT id FROM ledger_scratch_text)",
    ),
    db.prepare("DELETE FROM ledger_scratch_text"),
  ]);
  return updates.length;
}

/** 요청 값 검사 */
export function parseNoteItems(body: unknown): NoteItem[] {
  const list = Array.isArray((body as { items?: unknown })?.items) ? ((body as { items: unknown[] }).items as Record<string, unknown>[]) : null;
  if (!list || list.length > 3000) throw new Error("기록이 없거나 너무 많아요 (3,000개까지).");
  return list
    .filter(
      (r) =>
        typeof r.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
        Number.isInteger(r.amount) &&
        (r.amount as number) > 0 &&
        typeof r.note === "string" &&
        r.note.trim(),
    )
    .map((r) => ({ date: r.date as string, amount: r.amount as number, title: typeof r.title === "string" ? r.title.slice(0, 200) : "", note: (r.note as string).trim().slice(0, 2000) }));
}
