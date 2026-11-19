import { beforeEach, describe, expect, it } from "vitest";
import { openMigratedSqlite, type SqliteDb } from "@homebase/db/sqlite";
import { deleteTagRule, forgetTagRules, loadTagRules, setTagRule, tagsOf, wordsForTag } from "./tags.ts";

describe("tagsOf", () => {
  const rules = [
    { word: "몽이", tag: "반려동물" },
    { word: "사료", tag: "반려동물" },
    { word: "출장", tag: "출장" },
  ];

  it("메모에 든 낱말로 태그를 붙인다", () => {
    expect(tagsOf("몽이 예방접종", rules)).toEqual(["반려동물"]);
    expect(tagsOf("영수증\n몽이 사료 주문", rules)).toEqual(["반려동물"]); // 같은 태그는 한 번만
    expect(tagsOf("출장 숙박 · 몽이 간식", rules)).toEqual(["반려동물", "출장"]); // 규칙 순서대로
  });

  it("없으면 빈 배열", () => {
    expect(tagsOf("그냥 점심", rules)).toEqual([]);
    expect(tagsOf(null, rules)).toEqual([]);
    expect(tagsOf("몽이", [])).toEqual([]);
  });

  it("태그 이름으로 낱말을 되찾는다 (검색이 쓴다)", () => {
    expect(wordsForTag(rules, "반려동물")).toEqual(["몽이", "사료"]);
    expect(wordsForTag(rules, "반려동물".toUpperCase())).toEqual(["몽이", "사료"]);
    expect(wordsForTag(rules, "없는태그")).toEqual([]);
  });
});

describe("태그 규칙 저장", () => {
  let db: SqliteDb;
  beforeEach(() => {
    db = openMigratedSqlite();
    forgetTagRules();
  });

  it("넣고 고치고 지운다", async () => {
    await setTagRule(db, "몽이", "반려동물");
    expect(await loadTagRules(db)).toEqual([{ word: "몽이", tag: "반려동물" }]);
    // 같은 낱말을 다시 넣으면 태그 이름만 바뀐다
    await setTagRule(db, "몽이", "강아지");
    expect(await loadTagRules(db)).toEqual([{ word: "몽이", tag: "강아지" }]);
    await deleteTagRule(db, "몽이");
    expect(await loadTagRules(db)).toEqual([]);
  });

  it("다른 설정은 안 집어 온다", async () => {
    db.raw.prepare("INSERT INTO ledger_settings (key, value) VALUES ('memo.rule.-1000.가짜', '어떤 메모')").run();
    await setTagRule(db, "몽이", "반려동물");
    expect(await loadTagRules(db)).toEqual([{ word: "몽이", tag: "반려동물" }]);
  });
});
