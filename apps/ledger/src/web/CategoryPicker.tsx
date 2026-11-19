import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CategoryOption } from "./api.ts";
import { buildTree, groupsForKind, newCategoryFromQuery, searchCategories, type CategoryGroup, type SearchHit } from "./category-search.ts";

/** 고른 값: 기존 카테고리 id, 새로 만들 이름("대분류" 또는 "대분류 > 소분류"), 또는 없음 */
export type CategoryChoice = { id: number } | { newPath: string } | null;

interface Props {
  categories: CategoryOption[];
  value: CategoryChoice;
  onChange(value: CategoryChoice): void;
  /** 새 카테고리 만들기를 허용할지 */
  allowCreate?: boolean;
  /** 날짜 상세처럼 좁은 곳에 쓰는 작은 버튼 */
  compact?: boolean;
  /** 지출이면 지출 카테고리만, 수입이면 수입 카테고리만 보여준다 */
  kind?: "expense" | "income";
}

type Item = { kind: "hit"; hit: SearchHit } | { kind: "create"; path: string };

/**
 * 검색되는 두 단 카테고리 선택기.
 * - 검색어가 없으면 왼쪽 대분류, 오른쪽 그 소분류 (마우스를 올리거나 방향키로 이동)
 * - 검색어를 치면 대분류·소분류를 한 목록으로 (초성, "식비 > 한" 형식도 됨)
 */
export function CategoryPicker({ categories, value, onChange, allowCreate = true, compact = false, kind }: Props) {
  const tree = useMemo(() => groupsForKind(buildTree(categories), kind), [categories, kind]);
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [majorIndex, setMajorIndex] = useState(0);
  const [column, setColumn] = useState<"major" | "minor">("major");
  const [minorIndex, setMinorIndex] = useState(0);
  // 표 카드(overflow)에 잘리지 않게 화면 기준(fixed)으로 띄운다
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number }>({ left: 0, top: 0, width: 440 });
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = value && "id" in value ? byId.get(value.id) : undefined;
  const label = selected ? selected.label.replace(" > ", " › ") : value && "newPath" in value ? `새로 만들기: ${value.newPath.replace(">", "›")}` : null;

  const hits = useMemo(() => searchCategories(tree, query), [tree, query]);
  const create = allowCreate ? newCategoryFromQuery(tree, query) : null;
  const items: Item[] = [
    ...hits.map((hit): Item => ({ kind: "hit", hit })),
    ...(create ? [{ kind: "create" as const, path: create.minor ? `${create.major} > ${create.minor}` : create.major }] : []),
  ];

  function place() {
    const rect = root.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(440, window.innerWidth - 32);
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - 16 - width));
    const below = window.innerHeight - rect.bottom;
    setPos(below < 400 && rect.top > below ? { left, bottom: window.innerHeight - rect.top + 4, width } : { left, top: rect.bottom + 4, width });
  }

  // 열 때: 지금 고른 값의 대분류를 보여준다
  function openPicker() {
    place();
    const currentMajor = selected ? (selected.parentId ?? selected.id) : null;
    const i = tree.findIndex((g) => g.major.id === currentMajor);
    setMajorIndex(Math.max(0, i));
    setColumn("major");
    setMinorIndex(0);
    setQuery("");
    setActive(0);
    setOpen(true);
  }

  function choose(v: CategoryChoice) {
    onChange(v);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onMove = (e: Event) => {
      if (!(e.target instanceof Node && root.current?.contains(e.target))) place();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  // 방향키로 움직인 항목이 보이도록
  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active, majorIndex, minorIndex, column]);

  const group: CategoryGroup | undefined = tree[majorIndex];

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter 는 무시
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (query) {
      if (e.key === "ArrowDown") setActive((i) => Math.min(items.length - 1, i + 1));
      else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
      else if (e.key === "Enter") {
        const item = items[active];
        if (item) choose(item.kind === "hit" ? { id: item.hit.category.id } : { newPath: item.path });
      } else return;
      e.preventDefault();
      return;
    }
    // 두 단 탐색
    const minorsCount = group?.minors.length ?? 0;
    if (e.key === "ArrowDown") {
      if (column === "major") setMajorIndex((i) => Math.min(tree.length - 1, i + 1));
      else setMinorIndex((i) => Math.min(minorsCount, i + 1));
    } else if (e.key === "ArrowUp") {
      if (column === "major") setMajorIndex((i) => Math.max(0, i - 1));
      else setMinorIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "ArrowRight" && minorsCount) {
      setColumn("minor");
      setMinorIndex(0);
    } else if (e.key === "ArrowLeft") setColumn("major");
    else if (e.key === "Enter" && group) {
      // 소분류 칸의 0번은 '대분류 전체'
      const pick = column === "minor" && minorIndex > 0 ? group.minors[minorIndex - 1]! : group.major;
      if (column === "major" && minorsCount) {
        setColumn("minor");
        setMinorIndex(0);
      } else choose({ id: pick.id });
    } else return;
    e.preventDefault();
  }

  return (
    <div className="cp" ref={root}>
      <button
        type="button"
        className={`cp-trigger ${label ? "" : "is-empty"} ${compact ? "is-compact" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <span>{label ?? (compact ? "미분류" : "카테고리 선택")}</span>
        <svg className="cp-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="cp-pop" style={pos} role="dialog" aria-label="카테고리 선택">
          <input
            className="cp-search"
            autoFocus
            placeholder="검색 (예: 식비, ㅅㅂ, 식비 > 한식)"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            aria-label="카테고리 검색"
          />

          <div className="cp-body" ref={listRef}>
            {query ? (
              <ul className="cp-results" role="listbox">
                {items.map((item, i) => (
                  <li key={item.kind === "hit" ? item.hit.category.id : `new-${item.path}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      className={`${i === active ? "is-active" : ""} ${item.kind === "create" ? "cp-create" : ""} ${item.kind === "hit" && item.hit.category.id === selected?.id ? "is-current" : ""}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => choose(item.kind === "hit" ? { id: item.hit.category.id } : { newPath: item.path })}
                    >
                      {item.kind === "hit" ? (
                        <HitLabel hit={item.hit} />
                      ) : (
                        <>
                          <span>+ &lsquo;{item.path.replace(">", "›")}&rsquo; 새로 만들기</span>
                          <span className="cp-sub">{item.path.includes(">") ? "소분류로" : "대분류로"}</span>
                        </>
                      )}
                    </button>
                  </li>
                ))}
                {!items.length && <li className="cp-empty">맞는 카테고리가 없어요</li>}
              </ul>
            ) : (
              <div className="cp-columns">
                <ul className="cp-majors" role="listbox" aria-label="대분류">
                  {tree.map((g, i) => (
                    <li key={g.major.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected?.id === g.major.id}
                        className={`${i === majorIndex ? (column === "major" ? "is-active" : "is-open") : ""} ${selected && (selected.parentId ?? selected.id) === g.major.id ? "is-current" : ""}`}
                        onMouseEnter={() => {
                          setMajorIndex(i);
                          setColumn("major");
                        }}
                        onClick={() => (g.minors.length ? (setMajorIndex(i), setColumn("minor"), setMinorIndex(0)) : choose({ id: g.major.id }))}
                      >
                        <span>{g.major.name}</span>
                        {g.minors.length > 0 && <span className="cp-sub">{g.minors.length} ›</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                <ul className="cp-minors" role="listbox" aria-label="소분류">
                  {group && (
                    <>
                      <li>
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected?.id === group.major.id}
                          className={`${column === "minor" && minorIndex === 0 ? "is-active" : ""} ${selected?.id === group.major.id ? "is-current" : ""}`}
                          onMouseEnter={() => {
                            setColumn("minor");
                            setMinorIndex(0);
                          }}
                          onClick={() => choose({ id: group.major.id })}
                        >
                          <span>{group.major.name}</span>
                          <span className="cp-sub">대분류만</span>
                        </button>
                      </li>
                      {group.minors.map((m, i) => (
                        <li key={m.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected?.id === m.id}
                            className={`${column === "minor" && minorIndex === i + 1 ? "is-active" : ""} ${selected?.id === m.id ? "is-current" : ""}`}
                            onMouseEnter={() => {
                              setColumn("minor");
                              setMinorIndex(i + 1);
                            }}
                            onClick={() => choose({ id: m.id })}
                          >
                            {m.name}
                          </button>
                        </li>
                      ))}
                    </>
                  )}
                </ul>
              </div>
            )}
          </div>

          <div className="cp-foot">
            <button type="button" onClick={() => choose(null)}>
              카테고리 없음
            </button>
            {allowCreate && <span>없는 이름을 검색하면 새로 만들 수 있어요</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function highlight(text: string, range: { start: number; end: number } | null): ReactNode {
  if (!range || range.end <= range.start) return text;
  return (
    <>
      {text.slice(0, range.start)}
      <mark>{text.slice(range.start, range.end)}</mark>
      {text.slice(range.end)}
    </>
  );
}

function HitLabel({ hit }: { hit: SearchHit }) {
  const isMinor = hit.category.parentId !== null;
  return isMinor ? (
    <span>
      <span className="cp-path">{hit.major.name} › </span>
      {highlight(hit.category.name, hit.highlight)}
    </span>
  ) : (
    <>
      <span>{highlight(hit.category.name, hit.highlight)}</span>
      <span className="cp-sub">대분류</span>
    </>
  );
}
