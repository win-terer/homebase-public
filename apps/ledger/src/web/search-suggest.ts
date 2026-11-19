/** 검색 자동완성: 마지막 말(띄어쓰기 = AND)을 가게 이름·카테고리·메모 중에서 채운다 */
import { choseong } from "./category-search.ts";

export interface SearchTerm {
  text: string;
  n: number;
}

export interface SearchTerms {
  merchants: SearchTerm[];
  memos: SearchTerm[];
  categories: string[];
}

export interface SearchSuggestion {
  kind: "가게" | "카테고리" | "메모";
  text: string;
  /** 고르면 입력칸에 들어갈 전체 검색어 */
  query: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_()·/-]/g, "");

/** 0 = 앞부분 일치, 1 = 중간 일치, -1 = 안 맞음 (초성만 쳤으면 초성으로) */
function rank(text: string, word: string): number {
  const q = norm(word);
  if (/^[ㄱ-ㅎ]+$/.test(q)) {
    const c = norm(choseong(text));
    return c.startsWith(q) ? 0 : c.includes(q) ? 1 : -1;
  }
  const t = norm(text);
  return t.startsWith(q) ? 0 : t.includes(q) ? 1 : -1;
}

export function suggestSearch(terms: SearchTerms, input: string, limit = 8): SearchSuggestion[] {
  const cut = input.lastIndexOf(" ");
  const head = input.slice(0, cut + 1);
  const word = input.slice(cut + 1);
  if (!word.trim()) return [];
  // 금액(숫자만)은 자동완성하지 않는다
  if (/^\d+$/.test(word)) return [];
  const already = new Set(head.split(/\s+/).filter(Boolean).map(norm));
  const pool: { kind: SearchSuggestion["kind"]; text: string; n: number; r: number }[] = [];
  const add = (kind: SearchSuggestion["kind"], text: string, n: number) => {
    if (norm(text) === norm(word) || already.has(norm(text))) return;
    const r = rank(text, word);
    if (r >= 0) pool.push({ kind, text, n, r });
  };
  // 카테고리는 몇 개 안 되지만 정확한 묶음이라 맞으면 위로
  for (const c of terms.categories) add("카테고리", c, 1_000_000);
  for (const m of terms.merchants) add("가게", m.text, m.n);
  for (const m of terms.memos) add("메모", m.text, m.n);
  const seen = new Set<string>();
  return pool
    .sort((a, b) => a.r - b.r || b.n - a.n || a.text.localeCompare(b.text))
    .filter((p) => (seen.has(p.text) ? false : (seen.add(p.text), true)))
    .slice(0, limit)
    .map((p) => ({ kind: p.kind, text: p.text, query: head + p.text }));
}
