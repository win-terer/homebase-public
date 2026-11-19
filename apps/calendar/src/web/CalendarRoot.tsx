import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link, Route, Routes, useSearchParams } from "react-router";
import { amountView, ledgerApi, withSavedMemo, won, type CategoryOption, type Transaction } from "@homebase/ledger/web/api.ts";
import { useCellTip, type TipContent } from "@homebase/ledger/web/CellTip.tsx";
import { TxRow } from "@homebase/ledger/web/DayPanel.tsx";
import { useMemoUses } from "@homebase/ledger/web/MemoEditor.tsx";
import type { CategoryChoice } from "@homebase/ledger/web/CategoryPicker.tsx";
import { cancelsOf, daySpending } from "@homebase/ledger/web/day-view.ts";
import { mergeSplits, splitSummary } from "@homebase/ledger/web/split-pay.ts";
import { itemsThatFit, useFillHeight, useWide } from "@homebase/ledger/web/fill-height.ts";
import { addMonths, formatDay, formatMonth, monthGrid, today, WEEKDAY_LABELS, weekday } from "@homebase/ledger/web/dates.ts";
import { useHolidays } from "@homebase/ledger/web/holidays.ts";
import { DayPopover } from "@homebase/ledger/web/DayPopover.tsx";
import { plannedByDate, type Planned, type RecurringItem } from "@homebase/ledger/web/recurring.ts";
import "@homebase/ledger/web/ledger.css";
import { addDays, daysBetween, expandEvents, repeatLabel, timeLabel, type CalendarEvent, type Occurrence } from "../shared/occurrences.ts";
import { calendarApi, type Category, type EventInput } from "./api.ts";
import { CategoryEditor } from "./CategoryEditor.tsx";
import { EventForm, type SaveScope, type Seed } from "./EventForm.tsx";
import { QuickAdd } from "./QuickAdd.tsx";
import { ImportPage } from "./ImportPage.tsx";
import { CalendarSearchBox, CalendarSearchPage } from "./SearchPage.tsx";
import { PhotoMark, usePhotoMarks } from "@homebase/core/photos-web";
import "./calendar.css";

/** 줄 높이를 아직 못 쟀을 때(좁은 화면 등) 쓰는 기본 줄 수 */
const MAX_ITEMS = 7;

/** 가계부를 달력에 같이 보일지 — 기기(브라우저)마다 기억한다 (금액 가리기와 같은 방식) */
const MONEY_KEY = "hb.calendar.money";

function useShowMoney(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(MONEY_KEY) !== "off";
    } catch {
      return true;
    }
  });
  return [
    on,
    (v: boolean) => {
      setOn(v);
      try {
        localStorage.setItem(MONEY_KEY, v ? "on" : "off");
      } catch {
        // 저장이 막힌 브라우저에서도 이번 방문 동안은 동작한다
      }
    },
  ];
}

type Side = { mode: "day" } | { mode: "new"; seed?: Seed } | { mode: "edit"; occurrence: Occurrence } | { mode: "categories" };

/**
 * 일정: 월 달력(일정 + 그날 쓴 돈 + 정기 결제 예정) + 누른 날의 상세·추가·수정.
 *
 * **PC 는 누른 칸 옆 팝업**이다 (가계부 달력과 같은 방식, 2026-10-06). 오른쪽에 패널을 늘
 * 열어 두던 것을 바꾼 이유: 달력이 폭을 다 쓰고, 날짜를 누르자마자 **한 줄 추가**에 바로
 * 칠 수 있다(사용자 요청). 좁은 화면은 그대로 달력 아래 패널.
 */
export function CalendarRoot() {
  return (
    <Routes>
      <Route index element={<CalendarPage />} />
      <Route path="import" element={<ImportPage />} />
      <Route path="search" element={<CalendarSearchPage />} />
    </Routes>
  );
}

function CalendarPage() {
  // 사진 붙은 일정·거래 → 줄에 작은 카메라 (앱마다 한 번만 받아 공유)
  const evPhotos = usePhotoMarks("calendar");
  const txPhotos = usePhotoMarks("ledger");
  const [params, setParams] = useSearchParams();
  const todayDate = today();
  const month = params.get("month") ?? todayDate.slice(0, 7);
  const days = useMemo(() => monthGrid(month), [month]);
  const from = days[0]!;
  const to = days[days.length - 1]!;
  const wide = useWide();
  // 누른 날만 연다 — 팝업이라 저절로 뜨면 거슬린다 (패널이던 시절엔 오늘을 미리 열어 뒀다)
  const selected = params.get("date");
  const holidays = useHolidays(days);

  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setError(null);
    calendarApi.events(from, to).then(
      (r) => {
        setEvents(r.events);
        setCategories(r.categories);
      },
      (e: Error) => setError(e.message),
    );
  }, [from, to, reload]);

  // 가계부: 그날 쓴 돈, 정기 결제 예정. **끄면 아예 부르지 않는다** (요청 두 번이 통째로 빠진다)
  const [showMoney, setShowMoney] = useShowMoney();
  const [txs, setTxs] = useState<Transaction[]>([]);
  useEffect(() => {
    if (!showMoney) return setTxs([]);
    ledgerApi.transactions(from, to).then(setTxs, () => setTxs([]));
  }, [from, to, showMoney]);
  const [recurring, setRecurring] = useState<RecurringItem[] | null>(null);
  const showsFuture = to >= todayDate;
  useEffect(() => {
    if (showMoney && showsFuture && recurring === null) ledgerApi.recurring().then((r) => setRecurring(r.items), () => setRecurring([]));
  }, [showMoney, showsFuture, recurring]);
  const planned = useMemo(
    () => (showMoney && recurring ? plannedByDate(recurring, todayDate, from, to) : new Map<string, Planned[]>()),
    [showMoney, recurring, todayDate, from, to],
  );
  /** 갈려 들어온 결제를 한 줄로 — 가계부 달력과 같은 규칙(split-pay.ts), 취소 짝보다 먼저 */
  const txRows = useMemo(() => mergeSplits(txs), [txs]);
  const txByDate = useMemo(() => {
    const byDate = new Map<string, Transaction[]>();
    for (const t of txRows) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
    return byDate;
  }, [txRows]);
  /**
   * 결제·환불 짝은 **기간 전체로 한 번에** 맞춘다 — 가계부 달력과 같은 규칙(day-view.ts).
   * 칸마다 그날치로 맞추면 이틀 뒤에 들어온 취소를 못 묶는다.
   */
  const cancels = useMemo(() => cancelsOf(txRows), [txRows]);

  /**
   * 돈 줄을 누르면 가계부 달력과 **같은 고정 상자**(분류·메모·사진, `TxRow`)가 뜬다 (사용자 요청 2026-10-09).
   * 분류 목록·메모 자동완성은 처음 누를 때 한 번 받는다 — 일정만 보는 날엔 안 부른다.
   */
  const [txEditing, setTxEditing] = useState(false);
  const [txCategories, setTxCategories] = useState<CategoryOption[]>([]);
  const { memoUses, addMemoUse, refreshMemoUses } = useMemoUses(txEditing);
  useEffect(() => {
    if (txEditing && !txCategories.length) ledgerApi.categories().then(setTxCategories, () => {});
  }, [txEditing, txCategories.length]);
  async function saveMemo(id: number, change: { memo?: string | null; note?: string | null }) {
    const saved = await ledgerApi.setMemo(id, change);
    const tx = txs.find((t) => t.id === id);
    setTxs((list) => list.map((t) => (t.id === id ? withSavedMemo(t, saved) : t)));
    if (tx && saved.memo && change.memo !== undefined) addMemoUse(tx, saved.memo);
  }
  async function changeCategory(id: number, choice: CategoryChoice): Promise<{ categoryId: number | null; label: string | null }> {
    const created = choice !== null && "newPath" in choice;
    const saved = await ledgerApi.setCategory(id, created ? { newCategory: choice.newPath } : { categoryId: choice?.id ?? null });
    const list = created ? await ledgerApi.categories() : txCategories;
    if (created) setTxCategories(list);
    const cat = list.find((c) => c.id === saved.categoryId);
    const parent = cat?.parentId ? list.find((c) => c.id === cat.parentId) : undefined;
    setTxs((all) => all.map((t) => (t.id === id ? { ...t, categoryId: saved.categoryId, category: cat?.name ?? null, categoryGroup: parent?.name ?? cat?.name ?? null } : t)));
    return { categoryId: saved.categoryId, label: cat ? cat.label.replace(" > ", " › ") : null };
  }
  const { bind: tipOn, tip, pinned } = useCellTip<{ date: string; id: number }>(
    (key) => {
      const tx = txByDate.get(key.date)?.find((t) => t.id === key.id);
      return tx ? (
        <ul className="lg-rows lg-pin-rows">
          <TxRow
            tx={tx}
            cancel={cancels.cancelled.has(tx.id) ? "original" : null}
            onSaveMemo={saveMemo}
            categories={txCategories}
            onChangeCategory={changeCategory}
            memoUses={memoUses}
            onMemosApplied={() => {
              ledgerApi.transactions(from, to).then(setTxs, () => {});
              void refreshMemoUses();
            }}
          />
        </ul>
      ) : null;
    },
    (a, b) => a.date === b.date && a.id === b.id,
  );
  useEffect(() => {
    if (pinned) setTxEditing(true);
  }, [pinned]);
  /** 돈 줄 하나의 설명 상자 내용 (올리면 보기, 누르면 고정) — 가계부 달력과 같은 줄들 */
  const txTip = (t: Transaction): TipContent => ({
    title: t.memo || t.merchant,
    tags: [t.provisional ? "앱" : null, cancels.cancelled.has(t.id) ? "취소함" : null, t.splitParts ? `${t.splitParts.length}번에 나눠 냄` : null, txPhotos[String(t.id)] ? `사진 ${txPhotos[String(t.id)]}` : null, ...(t.tags ?? []).map((x) => `#${x}`)].filter((x): x is string => !!x),
    lines: [
      t.memo ? `가게 · ${t.merchant}` : null,
      [t.time?.slice(0, 5), t.splitParts ? splitSummary(t.splitParts) : t.paymentMethod].filter(Boolean).join(" · ") || null,
      `${amountView(t).text}원`,
      t.category ? (t.categoryGroup && t.categoryGroup !== t.category ? `${t.categoryGroup} › ${t.category}` : t.category) : "미분류",
      "누르면 분류·메모를 고칠 수 있어요",
    ],
    note: t.note,
  });

  const hidden = new Set(categories.filter((c) => c.hidden).map((c) => c.id));
  const byId = new Map(categories.map((c) => [c.id, c]));
  const occurrences = useMemo(
    () => expandEvents((events ?? []).filter((e) => e.categoryId === null || !hidden.has(e.categoryId)), from, to),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, from, to, categories],
  );

  // 달력이 화면 바닥까지 닿게 — 좁은 화면은 그대로 내용대로 (칸이 작아 늘려 봐야 빈 줄만 길어진다)
  const gridEl = useRef<HTMLDivElement>(null);
  const rowPx = useFillHeight(gridEl, Math.ceil(days.length / 7), wide);
  /**
   * 한 칸에 **들어갈 만큼만** 그린다. 줄 높이를 못 박았으니(`height`) 넘치는 건 잘려 나가는데,
   * 잘린 줄은 `+N건 더` 로 세어 줘야 한다 — 몇 줄이 들어가는지는 줄 높이에서 나온다.
   */
  const fit = itemsThatFit(rowPx, MAX_ITEMS);

  const [side, setSide] = useState<Side>({ mode: "day" });
  // 다른 날을 고르면 그날 상세로 (달력에서 일정을 눌러 날짜가 바뀐 경우는 그 일정 수정을 유지)
  useEffect(
    () => setSide((s) => (s.mode === "categories" || (s.mode === "edit" && s.occurrence.date === selected) ? s : { mode: "day" })),
    [selected],
  );

  // 모달은 Esc 로도 닫는다 (칸 옆 팝업은 DayPopover 가 제 몫을 한다)
  const editing = side.mode === "categories";
  useEffect(() => {
    if (!editing) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && setSide({ mode: "day" });
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [editing]);

  const go = (next: { month?: string; date?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.month) {
      p.set("month", next.month);
      if (next.date === undefined) p.delete("date");
    }
    if (next.date === null) p.delete("date");
    else if (next.date) p.set("date", next.date);
    setParams(p, { replace: true });
  };

  async function save(input: EventInput, scope: SaveScope) {
    if (side.mode === "edit") {
      const o = side.occurrence;
      if (scope === "one") await calendarApi.occurrence(o.event.id, o.start, input);
      else await calendarApi.update(o.event.id, input);
    } else await calendarApi.create(input);
    setSide({ mode: "day" });
    setReload((n) => n + 1);
  }

  /**
   * 일정을 **끌어다 다른 날로** 옮긴다 (사용자 요청 2026-10-06).
   *
   * 옮기는 폭은 **잡은 칸 기준**이다 — 여러 날짜리 일정의 가운데를 잡아 옮기면 잡은 날이 그
   * 자리로 가고 나머지가 따라온다(길이는 그대로). 시각·장소·메모는 손대지 않는다.
   *
   * 반복 일정은 **그 회차만** 옮긴다. 막대 하나를 끌었으면 그 하루를 옮기겠다는 뜻이지
   * 매주 전체를 밀겠다는 뜻은 아니다(전체를 옮기려면 일정을 열어 날짜를 고친다).
   *
   * 가계부 줄은 끌 수 없다 — 결제한 날을 바꿀 수는 없는 노릇이다.
   */
  /** 펼쳐 둔 날짜들 — `+N건 더`. 가계부 달력과 같이 **여러 칸을 동시에** 펼칠 수 있다(2026-11-12) */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleExpanded = (date: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(date)) next.add(date);
      return next;
    });
  const [dragging, setDragging] = useState<Occurrence | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  async function moveTo(o: Occurrence, date: string) {
    const shift = daysBetween(o.date, date);
    if (!shift) return;
    const e = o.event;
    const moved: EventInput = {
      title: e.title,
      categoryId: e.categoryId,
      startDate: addDays(o.start, shift),
      endDate: addDays(o.end, shift),
      startTime: e.startTime,
      endTime: e.endTime,
      location: e.location,
      memo: e.memo,
      repeat: e.repeat ? null : null,
      repeatUntil: null,
    };
    if (e.repeat) await calendarApi.occurrence(e.id, o.start, moved);
    else await calendarApi.update(e.id, moved);
    setReload((n) => n + 1);
  }

  /** 한 줄 추가 — 상자는 열어 둔 채로 비운다 (같은 날에 두어 개 적는 일이 흔하다) */
  async function quickAdd(input: EventInput) {
    await calendarApi.create(input);
    setReload((n) => n + 1);
  }

  async function remove(scope: SaveScope) {
    if (side.mode !== "edit") return;
    const o = side.occurrence;
    if (scope === "one") await calendarApi.occurrence(o.event.id, o.start);
    else await calendarApi.remove(o.event.id);
    setSide({ mode: "day" });
    setReload((n) => n + 1);
  }

  async function toggleCategory(c: Category) {
    setCategories((list) => list.map((x) => (x.id === c.id ? { ...x, hidden: !x.hidden } : x)));
    setCategories(await calendarApi.updateCategory(c.id, { hidden: !c.hidden }));
  }

  const dayOccurrences = selected ? (occurrences.get(selected) ?? []) : [];
  const dayPlanned = selected ? (planned.get(selected) ?? []) : [];
  // 그날 쓴 것 — "내가 그날 뭐 했더라" 를 떠올리는 데 액수보다 **어디서 썼나**가 낫다(사용자 요청)
  const dayTxs = useMemo(() => (selected ? daySpending(txByDate, selected, cancels) : []), [selected, txByDate, cancels]);

  return (
    <section className="lg-page cal-page">
      <div className="lg-toolbar">
        <div className="lg-month-nav">
          <h1>{formatMonth(month)}</h1>
          <div className="lg-nav-group">
            <button className="lg-icon-button" onClick={() => go({ month: addMonths(month, -1) })} aria-label="이전 달">
              ‹
            </button>
            <button className="lg-text-button" onClick={() => go({ month: todayDate.slice(0, 7), date: todayDate })}>
              오늘
            </button>
            <button className="lg-icon-button" onClick={() => go({ month: addMonths(month, 1) })} aria-label="다음 달">
              ›
            </button>
          </div>
        </div>
        <div className="cal-filters" aria-label="카테고리 보기">
          {categories.map((c) => (
            <button key={c.id} className={`cal-chip hb-c-${c.color} ${c.hidden ? "is-off" : ""}`} onClick={() => void toggleCategory(c)} aria-pressed={!c.hidden} title={c.hidden ? "켜기" : "끄고 보기"}>
              <span className="cal-dot" aria-hidden="true" />
              {c.name}
            </button>
          ))}
          {/* 가계부를 같이 볼지 — 카테고리 칩과 같은 모양으로, 끄면 흐려진다 */}
          <button
            className={`cal-chip hb-c-gray ${showMoney ? "" : "is-off"}`}
            onClick={() => setShowMoney(!showMoney)}
            aria-pressed={showMoney}
            title={showMoney ? "가계부를 같이 보는 중 — 끄면 일정만 보여요" : "그날 쓴 돈·쓴 내역·정기 결제 예정을 같이 봐요"}
          >
            <span className="cal-dot" aria-hidden="true" />
            가계부
          </button>
          <CalendarSearchBox className="cal-search" />
          <button className="cal-tool" onClick={() => setSide({ mode: "categories" })}>
            카테고리 편집
          </button>
          <Link className="cal-tool" to="/calendar/import">
            가져오기
          </Link>
        </div>
      </div>

      {error && <p className="hb-error">{error}</p>}

      <div className={`lg-layout ${selected && !wide ? "has-panel" : ""}`}>
        <div ref={gridEl} className={`lg-grid cal-grid is-fill ${events === null ? "is-loading" : ""} ${expanded.size ? "is-open" : ""}`} role="grid">
          {WEEKDAY_LABELS.map((w, i) => (
            <div key={w} className={`lg-weekday wd-${i}`} role="columnheader">
              {w}
            </div>
          ))}
          {days.map((date) => {
            const list = occurrences.get(date) ?? [];
            const plans = planned.get(date) ?? [];
            const holiday = holidays.get(date);
            // 일정과 그날 쓴 것을 **한 줄기 시간 순서**로 섞는다 — 그날이 어떻게 흘러갔는지가
            // 두 목록으로 갈라져 있으면 안 보인다(사용자 요청). 종일 일정은 맨 위, 시각 없는
            // 결제는 맨 아래.
            const spends = showMoney ? daySpending(txByDate, date, cancels) : [];
            const byTime = (a: { at: string }, b: { at: string }) => a.at.localeCompare(b.at);
            const evRows = list.map((o) => ({ at: o.start === o.end ? (o.event.startTime ?? "") : "", event: o, tx: null as Transaction | null }));
            const txRows = spends.map((t) => ({ at: t.time?.slice(0, 5) ?? "~", event: null as Occurrence | null, tx: t }));
            const open = expanded.has(date);
            /**
             * **일정이 먼저 자리를 잡는다.** 섞어서 앞에서 자르면 결제가 많은 날은 일정이
             * 통째로 `+N건 더` 뒤로 밀려 보이지도, 끌지도 못했다(사용자 지적). 남는 자리에만
             * 결제를 채운다. 펼친 칸은 전부 보여 준다 — 그때는 스크롤이 생겨도 괜찮다.
             */
            const total = evRows.length + txRows.length + plans.length;
            // 다 안 들어가면 마지막 한 줄은 `+N건 더` 몫으로 비운다
            const room = total > fit ? fit - 1 : fit;
            const evShown = open ? evRows : evRows.slice(0, room);
            const txShown = open ? txRows : txRows.slice(0, Math.max(0, room - evShown.length));
            const shown = [...evShown, ...txShown].sort(byTime);
            const planShown = open ? plans : plans.slice(0, Math.max(0, room - shown.length));
            const more = evRows.length - evShown.length + txRows.length - txShown.length + plans.length - planShown.length;
            return (
              <div
                key={date}
                className={[
                  "lg-cell",
                  `wd-${weekday(date)}`,
                  date.startsWith(month) ? "" : "is-outside",
                  date === todayDate ? "is-today" : "",
                  holiday ? "is-holiday" : "",
                  date === selected ? "is-selected" : "",
                dropOn === date ? "is-drop" : "",
                ].join(" ")}
                role="gridcell"
                data-date={date}
                tabIndex={0}
                aria-selected={date === selected}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault(); // 막아야 놓을 수 있는 자리가 된다
                  if (dropOn !== date) setDropOn(date);
                }}
                onDragLeave={() => setDropOn((d) => (d === date ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  const o = dragging;
                  setDragging(null);
                  setDropOn(null);
                  if (o) void moveTo(o, date);
                }}
                onClick={() => go({ date: date === selected ? null : date })}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go({ date }))}
              >
                <div className="lg-cell-head">
                  <span className="lg-daynum">{Number(date.slice(8))}</span>
                  {holiday && (
                    <span className="lg-holiday" title={holiday.join(", ")}>
                      {holiday.join(", ")}
                    </span>
                  )}
                </div>
                <ul className="lg-items">
                  {shown.map((row) => {
                    if (row.tx) {
                      const t = row.tx;
                      const v = amountView(t);
                      return (
                        <li
                          key={`tx-${t.id}`}
                          className={`cal-spend-row tone-${v.tone} ${cancels.cancelled.has(t.id) ? "is-cancelled" : ""}`}
                          {...tipOn(txTip(t), { date, id: t.id })}
                        >
                          {t.time && <span className="cal-time">{t.time.slice(0, 5)}</span>}
                          <span className="cal-title">{t.memo || t.merchant}</span>
                          <PhotoMark n={txPhotos[String(t.id)]} />
                          <span className={`cal-spend-amount ${v.tone === "in" ? "hb-secret" : ""}`}>{v.text}</span>
                        </li>
                      );
                    }
                    const o = row.event!;
                    const c = o.event.categoryId !== null ? byId.get(o.event.categoryId) : undefined;
                    const multi = o.start !== o.end;
                    return (
                      <li
                        key={`${o.event.id}-${o.start}`}
                        className={`cal-event hb-c-${c?.color ?? "gray"} ${multi ? "is-multi" : ""} ${o.event.startTime && !multi ? "" : "is-allday"} ${dragging?.event.id === o.event.id && dragging.start === o.start ? "is-dragging" : ""}`}
                        title={[o.event.title, timeLabel(o), o.event.location, o.event.memo, "끌어서 다른 날로 옮길 수 있어요"].filter(Boolean).join("\n")}
                        draggable
                        onDragStart={(e) => {
                          setDragging(o);
                          e.dataTransfer.effectAllowed = "move";
                          // 끄는 동안 브라우저가 무엇을 들고 있는지 알아야 한다(파이어폭스는 비면 아예 안 끌린다)
                          e.dataTransfer.setData("text/plain", o.event.title);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setDropOn(null);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          go({ date });
                          setSide({ mode: "edit", occurrence: o });
                        }}
                      >
                        {o.event.startTime && !multi && <span className="cal-time">{o.event.startTime}</span>}
                        <span className="cal-title">{o.event.title}</span>
                        <PhotoMark n={evPhotos[String(o.event.id)]} />
                      </li>
                    );
                  })}
                  {planShown.map((p) => (
                    <li key={`plan-${p.key}`} className={`lg-item is-planned ${p.direction === "in" ? "tone-in" : "tone-spend"}`} title={`정기 ${p.direction === "in" ? "입금" : "결제"} 예정 · ${p.name}`}>
                      <span className="lg-label">{p.memo || p.name}</span>
                      <span className={`lg-amount ${p.direction === "in" ? "hb-secret" : ""}`}>
                        {p.direction === "in" ? "+" : ""}
                        {p.variable ? "약 " : ""}
                        {won(p.amount)}
                      </span>
                    </li>
                  ))}
                  {(more > 0 || open) && (
                    <li>
                      <button
                        type="button"
                        className="lg-more cal-more"
                        onClick={(e) => {
                          e.stopPropagation(); // 칸을 누른 걸로 치면 상세가 열려 버린다
                          toggleExpanded(date);
                        }}
                      >
                        {open ? "접기" : `+${more}건 더`}
                      </button>
                    </li>
                  )}
                </ul>
                {list.length > 0 && <span className="lg-count">{list.length}개</span>}
              </div>
            );
          })}
        </div>

        {/* 카테고리 편집은 날짜와 상관없는 화면이라 칸 옆이 아니라 가운데 모달로 띄운다
            (2026-10-06: 달력 아래에 길게 붙던 것을 걷어냈다 — 화면 밖으로 밀려나 안 보였다) */}
        {side.mode === "categories" && (
          <div className="lg-dim" onMouseDown={(e) => e.target === e.currentTarget && setSide({ mode: "day" })}>
            <div className="lg-dialog cal-dialog" role="dialog" aria-label="카테고리 편집">
              <CategoryEditor categories={categories} onChange={setCategories} onClose={() => setSide({ mode: "day" })} />
            </div>
          </div>
        )}

        {selected && side.mode !== "categories" && (
          <DayBox wide={wide} date={selected} onClose={() => go({ date: null })}>
            <aside className="lg-panel cal-panel" aria-label="일정 상세">
              {side.mode === "new" || side.mode === "edit" ? (
                <EventForm
                  key={side.mode === "edit" ? `${side.occurrence.event.id}-${side.occurrence.start}` : `new-${selected}`}
                  date={selected}
                  occurrence={side.mode === "edit" ? side.occurrence : null}
                  seed={side.mode === "new" ? side.seed : null}
                  categories={categories}
                  onSave={save}
                  onDelete={remove}
                  onCancel={() => setSide({ mode: "day" })}
                />
              ) : (
                <DayDetail
                  date={selected}
                  holiday={holidays.get(selected)}
                  occurrences={dayOccurrences}
                  planned={dayPlanned}
                  txs={dayTxs}
                  cancelled={cancels.cancelled}
                  txBind={(t) => tipOn(txTip(t), { date: t.date, id: t.id })}
                  categories={categories}
                  byId={byId}
                  onQuickAdd={quickAdd}
                  onDetail={(seed) => setSide({ mode: "new", seed })}
                  onEdit={(o) => setSide({ mode: "edit", occurrence: o })}
                  onClose={() => go({ date: null })}
                />
              )}
            </aside>
          </DayBox>
        )}
      </div>
      {tip}
    </section>
  );
}

/**
 * 상세를 칸 옆 팝업으로 띄우는 넓은 화면 — 좁은 화면은 달력 아래 그대로.
 * 좁은 화면에서는 **눌렀을 때 그리로 데려간다** (달력이 화면보다 길어 눌러도 반응이 없어 보인다).
 */
function DayBox({ wide, date, onClose, children }: { wide: boolean; date: string; onClose(): void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wide) box.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [wide, date]);
  return wide ? (
    <DayPopover date={date} onClose={onClose}>
      {children}
    </DayPopover>
  ) : (
    <div ref={box}>{children}</div>
  );
}

function DayDetail({
  date,
  holiday,
  occurrences,
  planned,
  txs,
  cancelled,
  txBind,
  categories,
  byId,
  onQuickAdd,
  onDetail,
  onEdit,
  onClose,
}: {
  date: string;
  holiday: readonly string[] | undefined;
  occurrences: Occurrence[];
  planned: Planned[];
  txs: Transaction[];
  /** 취소선을 그을 줄 (day-view.ts) */
  cancelled: Set<number>;
  /** 돈 줄에 붙일 설명 상자 (누르면 분류·메모 편집) */
  txBind(t: Transaction): ReturnType<ReturnType<typeof useCellTip<{ date: string; id: number }>>["bind"]>;
  categories: Category[];
  byId: Map<number, Category>;
  onQuickAdd(input: EventInput): Promise<void>;
  onDetail(seed: Seed): void;
  onEdit(o: Occurrence): void;
  onClose(): void;
}) {
  const evPhotos = usePhotoMarks("calendar");
  return (
    <>
      <header className="lg-panel-head">
        <h2>
          {formatDay(date)}
          {holiday && <span className="lg-panel-holiday">{holiday.join(", ")}</span>}
        </h2>
        <button className="lg-icon-button" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </header>
      <QuickAdd date={date} categories={categories} onAdd={onQuickAdd} onDetail={onDetail} />
      {occurrences.length === 0 ? (
        <p className="hb-muted cal-empty">이날은 일정이 없어요.</p>
      ) : (
        <ul className="cal-rows">
          {occurrences.map((o) => {
            const c = o.event.categoryId !== null ? byId.get(o.event.categoryId) : undefined;
            const repeat = repeatLabel(o.event);
            return (
              <li key={`${o.event.id}-${o.start}`}>
                <button className={`cal-row hb-c-${c?.color ?? "gray"}`} onClick={() => onEdit(o)}>
                  <span className="cal-row-bar" aria-hidden="true" />
                  <span className="cal-row-time">{timeLabel(o)}</span>
                  <span className="cal-row-main">
                    <span className="cal-row-title">
                      {o.event.title}
                      <PhotoMark n={evPhotos[String(o.event.id)]} />
                    </span>
                    <span className="cal-row-meta">
                      {[c?.name, o.start !== o.end ? `${formatDay(o.start)} ~ ${formatDay(o.end)}` : null, repeat].filter(Boolean).join(" · ")}
                    </span>
                    {o.event.location && <span className="cal-row-place">{o.event.location}</span>}
                    {o.event.memo && <span className="cal-row-memo">{o.event.memo}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {(txs.length > 0 || planned.length > 0) && (
        <section className="cal-money">
          {/* 합계는 적지 않는다 — 그날이 어땠는지는 액수가 아니라 **몇 시에 어디서** 에 남는다(사용자 지적) */}
          <h3>
            돈 <Link to={`/ledger?month=${date.slice(0, 7)}&date=${date}`}>가계부에서 보기</Link>
          </h3>
          {/* 어디서 썼는지 한 줄씩 */}
          {txs.length > 0 && (
            <ul className="cal-spent">
              {txs.map((t) => {
                const v = amountView(t);
                return (
                  <li key={t.id} className={`cal-spent-row ${cancelled.has(t.id) ? "is-cancelled" : ""}`} {...txBind(t)}>
                    <span className="cal-spent-time">{t.time?.slice(0, 5) ?? ""}</span>
                    <span className="cal-spent-name">
                      {t.memo || t.merchant}
                    </span>
                    <span className={`cal-money-amount tone-${v.tone} ${v.sign === "+" ? "hb-secret" : ""}`}>{v.text}</span>
                  </li>
                );
              })}
            </ul>
          )}
          {planned.length > 0 && (
            <ul>
              {planned.map((p) => (
                <li key={p.key}>
                  <span className="hb-muted">예정</span>
                  <Link to={`/ledger/recurring?key=${encodeURIComponent(p.key)}`}>{p.memo || p.name}</Link>
                  <span className={`cal-money-amount ${p.direction === "in" ? "flow-in hb-secret" : ""}`}>
                    {p.direction === "in" ? "+" : ""}
                    {p.variable ? "약 " : ""}
                    {won(p.amount)}원
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
