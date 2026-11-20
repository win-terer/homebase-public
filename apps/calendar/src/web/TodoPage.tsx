/**
 * 할 일.
 *
 * 일정과 **따로** 있는 이유는 날짜가 없기 때문이다. 대신 기한을 러프하게 정할 수 있다
 * (언젠가 · 이번 주 · 이번 달 · 날짜). 카테고리는 일정 것을 그대로 쓰므로, '함께 보기' 를
 * 켠 카테고리의 할 일은 동거인에게도 열린다.
 *
 * 적는 자리는 **모달**이다. 목록 위에 폼을 펼쳐 뒀더니 적는 곳과 쌓인 것이 구분이 안 됐다
 * (사용자 지적 2026-11-20). 목록은 목록만 보여 주고, 적고 고치는 건 모달에서 한다.
 *
 * ## 쌓이는 걸 막는 장치
 *
 * 할 일 목록은 보통 **끝낸 것**이 아니라 **안 끝낸 것**이 쌓여서 죽는다. 그래서
 * - '언젠가' 는 따로 묶어 접어 둔다 — 이번 주 볼 것과 섞이면 둘 다 안 보게 된다
 * - 60일 넘게 손 안 댄 것은 흐려진다 (지우지는 않는다)
 * - 끝낸 것은 접어 두고 최근 것만 내려받는다
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { PhotoMark, PhotoStrip, usePhotoMarks } from "@homebase/core/photos-web";
import { DUE_KINDS, DUE_LABELS, dueLabel, isOverdue, STALE_DAYS, type DueKind, type Todo, type TodoInput } from "../shared/todos.ts";
import { categoryFromTitle } from "../shared/auto-category.ts";
import { calendarApi, type Category, type TodoList } from "./api.ts";
import { readGuestHidden, writeGuestHidden } from "./hidden.ts";

const daysSince = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);

/** 모달에 들어 있는 것 — 새로 적는 중이거나, 한 건을 고치는 중이거나 */
type Editing = { mode: "new" } | { mode: "edit"; todo: Todo };

export function TodoPage({ guest = false }: { guest?: boolean }) {
  const [data, setData] = useState<TodoList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [openSomeday, setOpenSomeday] = useState(false);
  const [openDone, setOpenDone] = useState(false);
  /** 방금 체크한 것 — 목록을 다시 받기 전까지 그 자리에서 취소선만 긋는다 */
  const [checking, setChecking] = useState<Set<number>>(new Set());
  /** 동거인이 끄고 본 카테고리 (주인은 서버 설정의 hidden 을 쓴다 — hidden.ts) */
  const [guestHidden, setGuestHidden] = useState<number[]>(readGuestHidden);
  const marks = usePhotoMarks("todo");

  const load = useCallback(async () => {
    try {
      setData(await calendarApi.todos());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const today = data?.today ?? new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
  const categories = useMemo(
    () => (data?.categories ?? []).map((c) => (guest ? { ...c, hidden: guestHidden.includes(c.id) } : c)),
    [data, guest, guestHidden],
  );
  const hiddenIds = useMemo(() => new Set(categories.filter((c) => c.hidden).map((c) => c.id)), [categories]);
  /** 끈 카테고리는 숨긴다. **분류 없음은 늘 보인다** — 끌 칩이 없으니 숨으면 되살릴 길이 없다 */
  const shown = useCallback((t: Todo) => t.categoryId === null || !hiddenIds.has(t.categoryId), [hiddenIds]);

  /** 카테고리 하나 끄고 켜기. 달력과 **같은 값**을 본다 (카테고리가 하나뿐이니 끈 것도 하나다) */
  const toggleCategory = async (c: Category) => {
    if (guest) {
      setGuestHidden((list) => {
        const next = list.includes(c.id) ? list.filter((id) => id !== c.id) : [...list, c.id];
        writeGuestHidden(next);
        return next;
      });
      return;
    }
    setData((d) => (d ? { ...d, categories: d.categories.map((x) => (x.id === c.id ? { ...x, hidden: !x.hidden } : x)) } : d));
    try {
      await calendarApi.updateCategory(c.id, { hidden: !c.hidden });
    } catch (e) {
      setError((e as Error).message);
      await load();
    }
  };

  /** 기한 있는 것 / 언젠가 — 섞어 두면 '언젠가' 가 목록을 덮는다 */
  const [dated, someday] = useMemo(() => {
    const open = (data?.open ?? []).filter(shown);
    return [open.filter((t) => t.dueDate), open.filter((t) => !t.dueDate)];
  }, [data, shown]);

  /** 체크/해제. 눌렀을 때 바로 반응하고, 다시 받아 자리를 옮긴다 */
  const toggleDone = async (t: Todo) => {
    setChecking((s) => new Set(s).add(t.id));
    try {
      await calendarApi.setTodoDone(t.id, !t.doneAt);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setChecking((s) => {
      const next = new Set(s);
      next.delete(t.id);
      return next;
    });
  };

  const row = (t: Todo, stale = false) => (
    <TodoRow
      key={t.id}
      todo={t}
      categories={categories}
      today={today}
      photos={marks[String(t.id)]}
      checking={checking.has(t.id)}
      stale={stale}
      onToggle={() => void toggleDone(t)}
      onEdit={() => setEditing({ mode: "edit", todo: t })}
    />
  );

  return (
    <section className="lg-page cal-todos">
      <div className="lg-toolbar cal-todo-bar">
        <h1>할 일</h1>
        {/* 적는 버튼은 제목 바로 옆 — 달력에서 달 넘기기가 제목 옆에 붙어 있는 것과 같은 자리다
            (사용자 요청 2026-11-20) */}
        <button type="button" className="hb-button cal-todo-new" onClick={() => setEditing({ mode: "new" })} aria-label="할 일 적기" title="할 일 적기">
          ＋
        </button>
        {/* 카테고리 칩은 **오른쪽** — 달력 툴바와 같은 자리에 둬야 눈이 헷갈리지 않는다 */}
        <div className="cal-filters" aria-label="카테고리 보기">
          {categories.map((c) => (
            <button
              key={c.id}
              className={`cal-chip hb-c-${c.color} ${c.hidden ? "is-off" : ""}`}
              onClick={() => void toggleCategory(c)}
              aria-pressed={!c.hidden}
              title={c.hidden ? "켜기" : "끄고 보기"}
            >
              <span className="cal-dot" aria-hidden="true" />
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="hb-error">{error}</p>}

      {data === null ? (
        <p className="hb-muted">불러오는 중…</p>
      ) : (
        <div className="cal-todo-card">
          <ul className="cal-todo-list">
            {dated.map((t) => row(t))}
            {dated.length === 0 && someday.length === 0 && <li className="hb-muted cal-todo-empty">아직 없어요. 제목 옆 [＋] 로 적어 보세요.</li>}
          </ul>

          {/* '언젠가' 는 접어 둔다 — 기한 있는 것과 섞이면 둘 다 안 보게 된다 */}
          {someday.length > 0 && (
            <>
              <button type="button" className="cal-todo-fold" aria-expanded={openSomeday} onClick={() => setOpenSomeday(!openSomeday)}>
                {openSomeday ? "▾" : "▸"} 언젠가 {someday.length}
              </button>
              {openSomeday && <ul className="cal-todo-list">{someday.map((t) => row(t, daysSince(t.createdAt) >= STALE_DAYS))}</ul>}
            </>
          )}

        </div>
      )}

      {/* 끝낸 것은 **판 밖**, 아래에 따로 둔다 — 할 일 목록과 같은 칸에 있으면 남은 일처럼 보인다
          (사용자 요청 2026-11-20) */}
      {data !== null && data.done.filter(shown).length > 0 && (
        <div className="cal-todo-done">
          <button type="button" className="cal-todo-fold is-loose" aria-expanded={openDone} onClick={() => setOpenDone(!openDone)}>
            {openDone ? "▾" : "▸"} 끝낸 것 {data.done.filter(shown).length}
            {data.done.length >= data.doneLimit ? "+" : ""}
          </button>
          {openDone && (
            <div className="cal-todo-card">
              <ul className="cal-todo-list is-done">{data.done.filter(shown).map((t) => row(t))}</ul>
            </div>
          )}
        </div>
      )}

      {editing && (
        <TodoDialog
          editing={editing}
          categories={categories}
          guest={guest}
          onSaved={() => {
            void load();
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/**
 * 목록 한 줄. 체크는 그 자리에서, **누르면 아래로 펼쳐진다** (사용자 요청 2026-11-20).
 * 펼친 자리는 **보는 자리**다 — 적힌 내용과 사진을 보고, 고칠 때만 [수정] 으로 모달을 연다.
 * 일정 쪽과 같은 규칙이다(보기 먼저, 수정은 버튼).
 */
function TodoRow({
  todo,
  categories,
  today,
  photos,
  checking,
  stale,
  onToggle,
  onEdit,
}: {
  todo: Todo;
  categories: Category[];
  today: string;
  photos?: number;
  checking: boolean;
  stale: boolean;
  onToggle(): void;
  onEdit(): void;
}) {
  const [open, setOpen] = useState(false);
  const cat = categories.find((c) => c.id === todo.categoryId);
  const done = !!todo.doneAt;
  const overdue = isOverdue(todo, today);

  return (
    <li className={`cal-todo ${done ? "is-done" : ""} ${checking ? "is-checking" : ""} ${stale ? "is-stale" : ""} ${open ? "is-open" : ""}`}>
      <div className="cal-todo-head">
        <input type="checkbox" className="cal-todo-check" checked={done} onChange={onToggle} aria-label={done ? "안 끝낸 것으로" : "끝냈어요"} />
        <button type="button" className="cal-todo-title" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="cal-todo-text">{todo.title}</span>
          {cat && (
            <span className={`cal-chip hb-c-${cat.color} is-tag`}>
              <span className="cal-dot" aria-hidden="true" />
              {cat.name}
            </span>
          )}
          <PhotoMark n={photos} />
          <span className={`cal-todo-due ${overdue ? "is-over" : ""}`}>{done ? `${daysSince(todo.doneAt!)}일 전 완료` : dueLabel(todo, today)}</span>
        </button>
      </div>
      {open && (
        <div className="cal-todo-detail">
          {todo.memo ? <p className="cal-todo-memo-view">{todo.memo}</p> : <p className="hb-muted">자세한 내용 없음</p>}
          {/* 여기서는 **붙인 사진만 본다.** 붙이는 건 [수정] 에서 — 보기 화면에 '＋ 사진' 이
              떠 있으면 붙일 자리인지 본 것인지 헷갈린다 (사용자 요청 2026-11-20) */}
          <PhotoStrip app="todo" refId={todo.id} readOnly />
          {/* 보는 자리에는 **[수정] 하나만.** 지우기는 고치기 화면에 둔다 — 일정과 같은 자리다
              (사용자 요청 2026-11-20) */}
          <div className="cal-todo-actions">
            <button type="button" className="hb-button" onClick={onEdit}>
              수정
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * 적고 고치는 자리. 새로 만들 때와 고칠 때가 같은 모달이다 — 칸이 똑같으니 두 벌 만들 이유가 없다.
 * 사진과 삭제는 여기 없다 — **펼친 줄**에 있다. 적고 고치는 칸만 둔다.
 */
function TodoDialog({
  editing,
  categories,
  guest,
  onSaved,
  onClose,
}: {
  editing: Editing;
  categories: Category[];
  guest: boolean;
  onSaved(): void;
  onClose(): void;
}) {
  const todo = editing.mode === "edit" ? editing.todo : null;
  const [title, setTitle] = useState(todo?.title ?? "");
  const [memo, setMemo] = useState(todo?.memo ?? "");
  const [dueKind, setDueKind] = useState<DueKind>(todo?.dueKind ?? "someday");
  const [dueDate, setDueDate] = useState(todo?.dueKind === "date" ? (todo.dueDate ?? "") : "");
  /** 고르기 전(새로 만들 때)에는 제목에서 짐작한다 — 일정 빠른 추가와 같은 규칙 */
  const [picked, setPicked] = useState<number | null | undefined>(todo ? todo.categoryId : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guessed = categoryFromTitle(title, categories);
  const categoryId = picked === undefined ? (guessed ?? categories[0]?.id ?? null) : picked;
  const ready = title.trim().length > 0 && !busy && (dueKind !== "date" || !!dueDate);

  // Esc 로 닫기 — 모달은 닫는 길이 여러 개여야 한다
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const input: TodoInput = { title: title.trim(), memo: memo.trim() || null, categoryId, dueKind, dueDate: dueKind === "date" ? dueDate : null };
    try {
      if (todo) await calendarApi.updateTodo(todo.id, input);
      else await calendarApi.addTodo(input);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <div className="lg-dim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="lg-dialog cal-todo-dialog" onSubmit={(e) => void submit(e)} role="dialog" aria-label={todo ? "할 일 고치기" : "할 일 적기"}>
        <header className="lg-panel-head">
          <h2>{todo ? "할 일" : "새 할 일"}</h2>
          <button type="button" className="lg-icon-button" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>

        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input className="cal-input" value={title} maxLength={200} placeholder="할 일 (예: 세탁기 필터 주문)" onChange={(e) => setTitle(e.target.value)} aria-label="할 일" autoFocus />
        <textarea className="cal-input cal-todo-memo" value={memo} maxLength={2000} rows={3} placeholder="자세한 내용" onChange={(e) => setMemo(e.target.value)} />

        <div className="cal-cat-pick" role="group" aria-label="기한">
          {DUE_KINDS.map((k) => (
            <button key={k} type="button" className={`cal-chip is-due ${dueKind === k ? "is-picked" : ""}`} aria-pressed={dueKind === k} onClick={() => setDueKind(k)}>
              {DUE_LABELS[k]}
            </button>
          ))}
          {dueKind === "date" && <input className="cal-input cal-todo-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="날짜" />}
        </div>

        <div className="cal-cat-pick" role="group" aria-label="분류">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`cal-chip hb-c-${c.color} ${categoryId === c.id ? "is-picked" : ""}`}
              aria-pressed={categoryId === c.id}
              onClick={() => setPicked(picked === c.id ? null : c.id)}
            >
              <span className="cal-dot" aria-hidden="true" />
              {c.name}
            </button>
          ))}
          <button type="button" className={`cal-chip is-none ${categoryId === null ? "is-picked" : ""}`} aria-pressed={categoryId === null} onClick={() => setPicked(null)}>
            <span className="cal-dot" aria-hidden="true" />
            없음
          </button>
        </div>

        {/* 사진은 붙일 곳의 번호가 있어야 한다 — 새로 적는 중에는 자리가 없다 */}
        {todo ? <PhotoStrip app="todo" refId={todo.id} /> : <span className="hb-muted cal-photo-later">적고 나면 [수정] 에서 사진을 붙일 수 있어요 (3장까지)</span>}

        {error && <p className="hb-error">{error}</p>}

        {/* 일정 고치기와 **같은 배치** — 왼쪽에 [저장]·[취소], 지우기는 멀리 오른쪽 끝에 */}
        <div className="cal-actions">
          <button className="hb-button" disabled={!ready}>
            {todo ? "저장" : "추가"}
          </button>
          <button type="button" className="hb-button is-secondary" onClick={onClose}>
            취소
          </button>
          {/* 지우기는 **주인만** — 동거인이 지운 걸 되살릴 방법이 없다 */}
          {todo && !guest && (
            <button
              type="button"
              className="lg-text-button cal-delete"
              disabled={busy}
              onClick={() => {
                if (!confirm(`'${todo.title}' 을(를) 지울까요? 붙인 사진도 같이 지워져요.`)) return;
                void calendarApi.removeTodo(todo.id).then(onSaved, (e: Error) => setError(e.message));
              }}
            >
              삭제
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
