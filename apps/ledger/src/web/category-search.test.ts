import { describe, expect, it } from "vitest";
import { buildTree, choseong, groupsForKind, newCategoryFromQuery, searchCategories } from "./category-search.ts";

const tree = buildTree([
  { id: 1, name: "식비", parentId: null },
  { id: 2, name: "한식", parentId: 1 },
  { id: 3, name: "일식", parentId: 1 },
  { id: 4, name: "주거/통신", parentId: null },
  { id: 5, name: "관리비", parentId: 4 },
  { id: 6, name: "보험", parentId: null },
  { id: 7, name: "생활", parentId: null },
  { id: 8, name: "식재료", parentId: 7 },
]);
const names = (q: string) => searchCategories(tree, q).map((h) => (h.category.parentId ? `${h.major.name}>${h.category.name}` : h.category.name));

describe("category search", () => {
  it("groups minors under majors", () => {
    expect(tree.map((g) => [g.major.name, g.minors.map((m) => m.name)])).toEqual([
      ["식비", ["한식", "일식"]],
      ["주거/통신", ["관리비"]],
      ["보험", []],
      ["생활", ["식재료"]],
    ]);
  });

  it("finds majors with their minors and matching minors elsewhere", () => {
    expect(names("식")).toEqual(["식비", "생활>식재료", "식비>한식", "식비>일식"]);
    expect(names("관리")).toEqual(["주거/통신>관리비"]);
    expect(names("주거통신")).toEqual(["주거/통신", "주거/통신>관리비"]);
  });

  it("supports initial consonants and the major > minor form", () => {
    expect(choseong("식비 ab")).toBe("ㅅㅂ ab");
    expect(names("ㅂㅎ")).toEqual(["보험"]);
    expect(names("식비 > 일")).toEqual(["식비>일식"]);
    expect(names("식비 >")).toEqual(["식비>한식", "식비>일식"]);
  });

  it("offers a new category only when the name is new", () => {
    expect(newCategoryFromQuery(tree, "의료")).toEqual({ major: "의료" });
    expect(newCategoryFromQuery(tree, "보험")).toBeNull();
    expect(newCategoryFromQuery(tree, "식비 > 분식")).toEqual({ major: "식비", minor: "분식" });
    expect(newCategoryFromQuery(tree, "식비 > 한식")).toBeNull();
    expect(newCategoryFromQuery(tree, "식비 >")).toBeNull();
  });
});

describe("groupsForKind", () => {
  const groups = buildTree([
    { id: 1, name: "식비", parentId: null },
    { id: 2, name: "급여", parentId: null },
    { id: 3, name: "상여/정산", parentId: 2 },
    { id: 4, name: "기타", parentId: null },
    { id: 5, name: "내가만든것", parentId: null },
  ]);
  const names = (kind?: "expense" | "income") => groupsForKind(groups, kind).map((g) => g.major.name);
  it("shows expense or income categories, and user-made ones on both sides", () => {
    expect(names("expense")).toEqual(["식비", "내가만든것"]);
    expect(names("income")).toEqual(["급여", "기타", "내가만든것"]);
    expect(names()).toHaveLength(4);
  });
});
