/** 메모 자동완성: 같은 원래 가게·같은 금액 → 같은 가게 → 자주 쓴 메모 순 */
import { choseong } from "./category-search.ts";

export interface MemoUse {
  memo: string;
  merchant: string;
  amount: number;
  count: number;
  last: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s/g, "");

/** 입력한 글자가 메모에 들어 있는지 (초성만 쳤으면 초성으로) */
function matches(memo: string, query: string): boolean {
  const q = norm(query);
  if (!q) return true;
  if (/^[ㄱ-ㅎ]+$/.test(q)) return choseong(memo).replace(/\s/g, "").includes(q);
  return norm(memo).includes(q);
}

export function suggestMemos(uses: MemoUse[], tx: { merchant: string; amount: number }, query: string, limit = 5): string[] {
  const score = new Map<string, number>();
  for (const u of uses) {
    if (!matches(u.memo, query)) continue;
    // 같은 가게·금액은 압도적으로, 같은 가게는 그다음, 나머지는 횟수로
    const weight = u.merchant === tx.merchant ? (u.amount === tx.amount ? 1_000_000 : 1_000) : 1;
    score.set(u.memo, (score.get(u.memo) ?? 0) + weight * u.count);
  }
  const typed = query.trim();
  return [...score]
    .filter(([memo]) => memo !== typed)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([memo]) => memo);
}
