/** 카테고리 선택기용: 대분류 > 소분류 트리 만들기와 검색 (초성 검색 포함) */
import { EXPENSE_MAJORS, INCOME_MAJORS } from "../importers/category-tree.ts";

export interface CategoryNode {
  id: number;
  name: string;
  parentId: number | null;
}

export interface CategoryGroup {
  major: CategoryNode;
  minors: CategoryNode[];
}

/** 서버가 준 순서(정렬된 목록)를 유지하며 대분류별로 묶는다 */
export function buildTree(list: CategoryNode[]): CategoryGroup[] {
  const groups = new Map<number, CategoryGroup>();
  for (const c of list) if (c.parentId === null) groups.set(c.id, { major: c, minors: [] });
  for (const c of list) if (c.parentId !== null) groups.get(c.parentId)?.minors.push(c);
  return [...groups.values()];
}

/**
 * 지출이면 지출 카테고리만, 수입이면 수입 카테고리만. 사용자가 새로 만든 대분류는 어느 쪽인지 몰라서 양쪽에 다 보인다
 */
export function groupsForKind(groups: CategoryGroup[], kind: "expense" | "income" | undefined): CategoryGroup[] {
  if (!kind) return groups;
  const other = kind === "income" ? EXPENSE_MAJORS : INCOME_MAJORS;
  return groups.filter((g) => !other.has(g.major.name));
}

const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** 한글 음절을 초성으로 (다른 글자는 그대로). 예: "식비" → "ㅅㅂ" */
export function choseong(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0) - 0xac00;
    out += code >= 0 && code < 11172 ? CHOSEONG[Math.floor(code / 588)] : ch;
  }
  return out;
}

const normalize = (s: string) => s.toLowerCase().replace(/[\s/·_()-]/g, "");
const isChoseongOnly = (s: string) => /^[ㄱ-ㅎ]+$/.test(s);

/** 이름이 검색어에 맞으면 맞은 위치(하이라이트용), 아니면 null. 초성만 친 경우는 초성으로 비교 */
export function matchName(name: string, query: string): { start: number; end: number } | null {
  const q = normalize(query);
  if (!q) return null;
  if (isChoseongOnly(q)) {
    const i = choseong(name).replace(/\s/g, "").indexOf(q);
    return i < 0 ? null : { start: 0, end: 0 };
  }
  const i = name.toLowerCase().indexOf(query.trim().toLowerCase());
  if (i >= 0) return { start: i, end: i + query.trim().length };
  return normalize(name).includes(q) ? { start: 0, end: 0 } : null;
}

export interface SearchHit {
  category: CategoryNode;
  major: CategoryNode;
  /** 소분류면 소분류 이름에서, 대분류면 대분류 이름에서 맞은 위치 */
  highlight: { start: number; end: number } | null;
}

/**
 * 검색 결과: 이름이 맞는 대분류와 소분류, 그리고 대분류가 맞으면 그 아래 소분류도 함께.
 * 순서는 이름이 검색어로 시작하는 것 → 나머지, 같은 대분류끼리 모아서.
 * "식비 > 한" 처럼 쓰면 대분류는 식비, 소분류는 '한'으로 좁힌다.
 */
export function searchCategories(tree: CategoryGroup[], query: string): SearchHit[] {
  const [majorQuery, minorQuery] = query.includes(">") ? query.split(">").map((s) => s.trim()) : [query.trim(), undefined];
  if (!majorQuery && !minorQuery) return [];
  const hits: (SearchHit & { rank: number })[] = [];
  for (const { major, minors } of tree) {
    if (minorQuery !== undefined) {
      if (majorQuery && !matchName(major.name, majorQuery)) continue;
      for (const m of minors) {
        const hl = minorQuery ? matchName(m.name, minorQuery) : { start: 0, end: 0 };
        if (hl) hits.push({ category: m, major, highlight: minorQuery ? hl : null, rank: 1 });
      }
      continue;
    }
    const majorHit = matchName(major.name, majorQuery);
    if (majorHit) hits.push({ category: major, major, highlight: majorHit, rank: major.name.startsWith(majorQuery) ? 0 : 1 });
    for (const m of minors) {
      const minorHit = matchName(m.name, majorQuery);
      if (minorHit) hits.push({ category: m, major, highlight: minorHit, rank: m.name.startsWith(majorQuery) ? 0 : 1 });
      else if (majorHit) hits.push({ category: m, major, highlight: null, rank: 2 });
    }
  }
  return hits.sort((a, b) => a.rank - b.rank).map(({ rank: _, ...h }) => h);
}

/** 검색어로 새로 만들 카테고리. "대분류 > 소분류" 형식이면 소분류로. 이미 있는 이름이면 null */
export function newCategoryFromQuery(tree: CategoryGroup[], query: string): { major: string; minor?: string } | null {
  const [major, minor] = query.split(">").map((s) => s.trim());
  if (!major || major.length > 30 || (minor !== undefined && (!minor || minor.length > 30))) return null;
  const group = tree.find((g) => g.major.name === major);
  if (minor === undefined) return group ? null : { major };
  if (group?.minors.some((m) => m.name === minor)) return null;
  return { major, minor };
}
