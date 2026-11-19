/**
 * 메모 낱말로 붙는 **태그**.
 *
 * 분류(카테고리)는 "이 돈이 어디로 나갔나" 한 가지로만 나뉜다. 그래서 한 가지를 여러 결로
 * 묶고 싶을 때(반려견에게 쓴 돈 — 병원이기도 하고 쇼핑이기도 하다) 분류를 덮으면 원래 쓰임이
 * 사라진다. 태그는 분류를 건드리지 않고 **옆에** 붙는다.
 *
 * 태그는 **저장하지 않는다.** 규칙(낱말 → 태그 이름)만 `ledger_settings` 에 두고, 메모에 그
 * 낱말이 있으면 그때그때 붙인다. 그래서
 *   - 예전 기록에도 저절로 붙는다 (따로 훑어 고치는 일회성 작업이 없다)
 *   - 메모를 고치면 태그도 바로 따라온다 (두 곳이 어긋날 일이 없다)
 *   - 규칙을 지우면 흔적 없이 사라진다
 */
import type { SqlDb } from "@homebase/db";

export interface TagRule {
  /** 메모에서 찾을 말 */
  word: string;
  /** 붙일 태그 이름 (낱말과 달라도 된다: '몽이' → '반려동물') */
  tag: string;
}

const PREFIX = "tag.rule.";
export const WORD_MAX = 30;
export const TAG_MAX = 20;
/** 규칙이 많아지면 메모마다 훑는 비용이 커진다. 개인용이라 이 정도면 넉넉하다 */
export const RULE_MAX = 50;

/** 메모에 붙는 태그. 규칙 순서대로, 같은 태그는 한 번만 */
export function tagsOf(memo: string | null | undefined, rules: readonly TagRule[]): string[] {
  if (!memo || rules.length === 0) return [];
  const out: string[] = [];
  for (const r of rules) if (memo.includes(r.word) && !out.includes(r.tag)) out.push(r.tag);
  return out;
}

/** 태그 이름으로 그 태그를 만드는 낱말들을 찾는다 (검색이 쓴다). 대소문자는 구분하지 않는다 */
export const wordsForTag = (rules: readonly TagRule[], tag: string): string[] =>
  rules.filter((r) => r.tag.toLowerCase() === tag.toLowerCase()).map((r) => r.word);

/* ── 규칙 읽고 쓰기 ────────────────────────────────────────────── */

// 규칙은 몇 줄뿐이지만 거래를 내보낼 때마다 읽으므로 인스턴스에 잠깐 둔다 (고치면 바로 비운다)
const TTL_MS = 10 * 60_000;
let cache: { at: number; rules: TagRule[] } | null = null;
export const forgetTagRules = () => {
  cache = null;
};

export async function loadTagRules(db: SqlDb): Promise<TagRule[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rules;
  const rows = (await db.prepare("SELECT key, value FROM ledger_settings WHERE key LIKE ? ESCAPE '\\'").bind(`${PREFIX}%`).all<{ key: string; value: string }>()).results;
  const rules = rows
    .map((r) => ({ word: r.key.slice(PREFIX.length), tag: r.value }))
    .filter((r) => r.word && r.tag)
    .sort((a, b) => a.tag.localeCompare(b.tag, "ko") || a.word.localeCompare(b.word, "ko"));
  cache = { at: Date.now(), rules };
  return rules;
}

export async function setTagRule(db: SqlDb, word: string, tag: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ledger_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(PREFIX + word.slice(0, WORD_MAX), tag.slice(0, TAG_MAX))
    .run();
  forgetTagRules();
}

export async function deleteTagRule(db: SqlDb, word: string): Promise<void> {
  await db.prepare("DELETE FROM ledger_settings WHERE key = ?").bind(PREFIX + word).run();
  forgetTagRules();
}
