import { useEffect, useMemo, useState } from "react";
import { ledgerApi, type CategoryOption, type CategoryUsage } from "./api.ts";
import { CategoryPicker } from "./CategoryPicker.tsx";
import { TagRules } from "./TagRules.tsx";

/**
 * 카테고리 관리 — 이름 · 순서 · 합치기 · 지우기.
 *
 * 그동안 카테고리는 거래의 분류를 고르다가 **만들기만** 됐다. 오타로 만든 것을 치울 길이
 * 없어서 목록에 영원히 남았다 (사용자 지적 2026-10-06).
 *
 * 지우기는 **쓰는 데가 없을 때만** 된다 — 거래가 딸린 카테고리를 지우면 그 거래가 통째로
 * 미분류로 풀리기 때문이다. 치우는 길은 **합치기**다: 거래를 받을 카테고리로 옮기고 빈
 * 껍데기를 지운다. 그래서 이 화면의 기본 동작은 지우기가 아니라 합치기다.
 */
export function CategoriesPage() {
  const [list, setList] = useState<CategoryUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 합칠 대상을 고르는 중인 카테고리 */
  const [merging, setMerging] = useState<number | null>(null);
  const [drag, setDrag] = useState<CategoryUsage | null>(null);
  const [over, setOver] = useState<number | null>(null);

  useEffect(() => {
    ledgerApi.categoryUsage().then(setList, (e: Error) => setError(e.message));
  }, []);

  /** 고치는 쪽은 바뀐 목록을 그대로 돌려준다 — 다시 조회하지 않는다 */
  async function run(action: () => Promise<{ categories: CategoryUsage[] }>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      setList((await action()).categories);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const majors = (list ?? []).filter((c) => c.parentId === null);
  const minorsOf = (id: number) => (list ?? []).filter((c) => c.parentId === id);

  /** 합칠 수 있는 곳. 자기 자신·자기 하위는 빼고, 하위가 있으면 대분류끼리만 */
  const targets = useMemo(() => {
    const byId = new Map((list ?? []).map((c) => [c.id, c]));
    return (me: CategoryUsage): CategoryOption[] => {
      const hasKids = (list ?? []).some((c) => c.parentId === me.id);
      return (list ?? [])
        .filter((c) => c.id !== me.id && c.parentId !== me.id && !(hasKids && c.parentId !== null))
        .map((c) => ({
          id: c.id,
          name: c.name,
          parentId: c.parentId,
          label: c.parentId === null ? c.name : `${byId.get(c.parentId)?.name ?? ""} > ${c.name}`,
        }));
    };
  }, [list]);

  async function merge(from: CategoryUsage, intoId: number) {
    const into = (list ?? []).find((c) => c.id === intoId);
    if (!into) return;
    const kids = minorsOf(from.id).length;
    const what = [from.transactions && `${from.transactions.toLocaleString()}건`, kids && `하위 분류 ${kids}개`].filter(Boolean).join(" · ") || "내용";
    if (!confirm(`'${from.name}'의 ${what}${josa(what, "을를")} '${into.name}'${josa(into.name, "으로로")} 옮기고 '${from.name}'${josa(from.name, "을를")} 지울까요?`)) return;
    setMerging(null);
    await run(() => ledgerApi.mergeCategory(from.id, intoId));
  }

  async function remove(c: CategoryUsage) {
    if (!confirm(`'${c.name}'${josa(c.name, "을를")} 지울까요?`)) return;
    await run(() => ledgerApi.deleteCategory(c.id));
  }

  /** 끌어 놓은 자리로 형제 순서를 다시 매긴다. 다른 대분류로는 넘기지 않는다 */
  async function drop(target: CategoryUsage) {
    const from = drag;
    setDrag(null);
    setOver(null);
    if (!from || !list || from.id === target.id || from.parentId !== target.parentId) return;
    const ids = list.filter((c) => c.parentId === target.parentId).map((c) => c.id);
    // 놓은 줄이 **있던 자리**를 차지한다 (아래로 끌면 그 줄은 위로 밀린다).
    // 뺀 뒤에 자리를 찾으면 아래로 끌 때 한 칸씩 모자라게 들어간다
    const to = ids.indexOf(target.id);
    ids.splice(ids.indexOf(from.id), 1);
    ids.splice(to, 0, from.id);
    const before = list;
    setList(reordered(list, target.parentId, ids)); // 기다리지 않고 먼저 옮긴다 (왕복이 LA 라 느리다)
    if (!(await run(() => ledgerApi.orderCategories(target.parentId, ids)))) setList(before);
  }

  // 끄는 건 손잡이로만 한다 (`draggable` 을 줄 전체에 주면 이름칸 글자를 끌어서 못 고른다).
  // dragstart 는 손잡이에서 올라오므로 받는 쪽은 줄에 둔다
  const rowProps = (c: CategoryUsage) => ({
    onDragStart: (e: React.DragEvent) => {
      setDrag(c);
      e.dataTransfer.effectAllowed = "move";
      // 무엇을 들고 있는지 브라우저에 알려야 한다 (파이어폭스는 비면 아예 안 끌린다)
      e.dataTransfer.setData("text/plain", c.name);
      const row = (e.target as HTMLElement).closest(".ct-row");
      if (row) e.dataTransfer.setDragImage(row, 20, row.clientHeight / 2); // 손잡이만 끌리는 것처럼 보이지 않게
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!drag || drag.parentId !== c.parentId) return; // 다른 대분류 밑으로는 못 놓는다
      e.preventDefault();
      if (over !== c.id) setOver(c.id);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      void drop(c);
    },
  });

  // 컴포넌트가 아니라 **함수**다. 컴포넌트로 두면 렌더마다 타입이 새로 생겨
  // 안의 입력칸이 다시 마운트되고, 이름을 치는 중에 포커스가 날아간다.
  /** 놓을 자리를 어느 쪽 선으로 보여 줄지 — 끌어내리는 중이면 아래, 끌어올리는 중이면 위 */
  const dropSide = (c: CategoryUsage) => {
    const ids = (list ?? []).filter((x) => x.parentId === c.parentId).map((x) => x.id);
    return drag && ids.indexOf(drag.id) < ids.indexOf(c.id) ? "is-over-below" : "is-over-above";
  };

  const row = (c: CategoryUsage) => {
    const kids = minorsOf(c.id).length;
    const why = kids
      ? "하위 분류가 남아 있어요"
      : c.transactions
        ? `${c.transactions.toLocaleString()}건이 이 카테고리예요 — 다른 카테고리로 합쳐 주세요`
        : c.rules
          ? "자동 분류 규칙이 이 카테고리를 써요"
          : "";
    return (
      <div className={`ct-row ${over === c.id ? dropSide(c) : ""} ${drag?.id === c.id ? "is-dragging" : ""}`} {...rowProps(c)}>
        <span className="ct-handle" draggable={!busy} role="button" tabIndex={-1} aria-label="끌어서 순서 바꾸기" title="끌어서 순서 바꾸기">
          ⠿
        </span>
        <input
          className="ct-name"
          key={`${c.id}:${c.name}`}
          defaultValue={c.name}
          maxLength={30}
          aria-label="이름"
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()}
          onBlur={async (e) => {
            const next = e.target.value.trim();
            if (!next || next === c.name) {
              e.target.value = c.name;
              return;
            }
            if (!(await run(() => ledgerApi.renameCategory(c.id, next)))) e.target.value = c.name;
          }}
        />
        <span className="ct-count">{countLabel(c, minorsOf(c.id))}</span>
        <span className="ct-rules">{c.rules ? `규칙 ${c.rules}` : ""}</span>
        {merging === c.id ? (
          <span className="ct-merge">
            <span className="hb-muted">어디로 →</span>
            <CategoryPicker categories={targets(c)} value={null} allowCreate={false} compact onChange={(v) => {
                if (v && "id" in v) void merge(c, v.id);
              }} />
            <button type="button" className="lg-text-button" onClick={() => setMerging(null)}>
              취소
            </button>
          </span>
        ) : (
          <span className="ct-actions">
            <button type="button" className="lg-text-button" disabled={busy} onClick={() => setMerging(c.id)}>
              합치기
            </button>
            <button type="button" className="lg-text-button ct-delete" disabled={busy || !!why} title={why} onClick={() => void remove(c)}>
              삭제
            </button>
          </span>
        )}
      </div>
    );
  };

  return (
    <section className="lg-page ct-page">
      <header className="ct-head">
        <h1>카테고리</h1>
        <p className="hb-muted">
          이름을 눌러 고치고 ⠿ 를 끌어 순서를 바꿔요. 거래가 걸린 카테고리는 지울 수 없어요 — <b>합치기</b>로 다른 카테고리에 넘기면 비워집니다.
        </p>
      </header>
      {error && <p className="hb-error">{error}</p>}
      {!list ? (
        <p className="hb-muted">불러오는 중…</p>
      ) : (
        <ul className="ct-list">
          {majors.map((major) => (
            <li key={major.id} className="ct-group">
              {row(major)}
              {minorsOf(major.id).length > 0 && (
                <ul className="ct-minors">
                  {minorsOf(major.id).map((minor) => (
                    <li key={minor.id}>
                      {row(minor)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <TagRules />
    </section>
  );
}

/** 받침에 따라 조사를 고른다 — 카테고리 이름은 사용자가 지어서 '분식를'·'한식으로' 가 그냥 나온다 */
function josa(word: string, pair: "을를" | "으로로"): string {
  const code = word.trim().slice(-1).charCodeAt(0) - 0xac00;
  const final = code >= 0 && code <= 11171 ? code % 28 : 0; // 한글이 아니면 받침 없는 쪽으로
  if (pair === "을를") return final ? "을" : "를";
  return final && final !== 8 ? "으로" : "로"; // ㄹ 받침(8)은 '로'
}

/**
 * 건수 칸. 대분류는 제 거래가 없는 게 보통이라(분류는 소분류에 붙는다) 그냥 '비어 있음' 이라고
 * 하면 지워도 되는 것처럼 보인다 — 하위 합계를 대신 보여 준다.
 */
function countLabel(c: CategoryUsage, kids: CategoryUsage[]) {
  if (c.transactions) return `${c.transactions.toLocaleString()}건`;
  const below = kids.reduce((n, k) => n + k.transactions, 0);
  if (below) return <span className="hb-muted">하위 {below.toLocaleString()}건</span>;
  return <span className="hb-muted">비어 있음</span>;
}

/** `parentId` 형제들을 `ids` 순서로 바꾼 목록 (나머지 자리는 그대로) */
function reordered(list: CategoryUsage[], parentId: number | null, ids: number[]): CategoryUsage[] {
  const byId = new Map(list.map((c) => [c.id, c]));
  const queue = ids.map((id) => byId.get(id)!);
  let i = 0;
  return list.map((c) => (c.parentId === parentId ? queue[i++]! : c));
}
