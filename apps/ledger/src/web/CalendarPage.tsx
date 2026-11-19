import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { CANCEL_WITHIN_DAYS, ledgerApi, spendOf, withSavedMemo, won, type CategoryOption, type LostMemo, type Transaction } from "./api.ts";
import { cancelsOf } from "./day-view.ts";
import { mergeSplits } from "./split-pay.ts";
import type { CategoryChoice } from "./CategoryPicker.tsx";
import { addMonths, formatMonth, monthGrid, shiftDays, today } from "./dates.ts";
import { DayPanel, TxRow } from "./DayPanel.tsx";
import { DayPopover } from "./DayPopover.tsx";
import { MonthGrid } from "./MonthGrid.tsx";
import { useMemoUses } from "./MemoEditor.tsx";
import { plannedByDate, type RecurringItem } from "./recurring.ts";

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const todayDate = today();
  const month = params.get("month") ?? todayDate.slice(0, 7);
  const days = useMemo(() => monthGrid(month), [month]);
  // 날짜 상세는 누른 날만. PC 는 칸 옆 팝업, 좁은 화면은 달력 아래 (2026-10-03, 오른쪽 고정 패널은 없앰)
  const wide = useWide();
  const selected = params.get("date");

  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryOption[]>([]);

  useEffect(() => {
    ledgerApi.categories().then(setCategories, () => {});
  }, []);

  /**
   * 달력에 그릴 날짜보다 **일주일 앞까지** 받는다. 취소 짝을 맞추려면 환불뿐 아니라 원래
   * 결제도 손에 있어야 하는데, 결제가 달력 왼쪽 끝보다 앞이면 그 달에서는 영영 못 묶여
   * `+19,400` 한 줄만 남는다. 앞 일주일은 그리지 않고 짝 맞추는 데만 쓴다.
   */
  const txFrom = useMemo(() => shiftDays(days[0]!, -CANCEL_WITHIN_DAYS), [days]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!reload) setTxs(null);
    setError(null);
    ledgerApi.transactions(txFrom, days[days.length - 1]!).then(setTxs, (e: Error) => setError(e.message));
  }, [txFrom, days, reload]);

  // 일정은 **여기 오지 않는다** — 가계부 달력에 일정을 섞던 것을 2026-10-06 에 걷어냈다.
  // 섞어 보고 싶은 방향은 그 반대였다: 일정 달력에 그날 쓴 것을 시간 순서로 끼워 넣는다
  // (apps/calendar). 가계부 달력은 돈만 본다.

  // 엑셀이 덮으면서 짝을 못 찾은 앱알림 메모 — 그 날짜 상세에서 붙인다 (설정 한 번 읽기, 캐시됨)
  const [lost, setLost] = useState<LostMemo[]>([]);
  useEffect(() => {
    ledgerApi.lostMemos().then(setLost, () => setLost([]));
  }, [reload]);
  const lostByDate = useMemo(() => {
    const map = new Map<string, LostMemo[]>();
    for (const l of lost) map.set(l.date, [...(map.get(l.date) ?? []), l]);
    return map;
  }, [lost]);

  // 메모 자동완성용 목록은 날짜 상세(팝업)를 처음 열 때 한 번 받는다 (검색·통계와 같이 씀)
  const { memoUses, addMemoUse, refreshMemoUses } = useMemoUses(Boolean(selected));

  // 정기 결제 예정: 오늘 이후가 보이는 달이면 한 번 받는다 (서버 10분 캐시)
  /**
   * 정기 결제는 **예정**(앞으로 나갈 것)과 **표시**(이미 나간 줄에 정기 표를 다는 것) 둘 다에
   * 쓰여서, 보는 달이 과거여도 받아 둔다. 서버가 10분 캐시하고 화면 캐시도 타므로 싸다.
   */
  const [recurring, setRecurring] = useState<RecurringItem[] | null>(null);
  useEffect(() => {
    if (recurring === null) ledgerApi.recurring().then((r) => setRecurring(r.items), () => setRecurring([]));
  }, [recurring]);
  /** 정기 결제로 나간 거래의 id — 달력·날짜 상세가 표를 달아 준다 */
  const recurringIds = useMemo(
    () => new Set((recurring ?? []).flatMap((r) => r.history.map((h) => h.id))),
    [recurring],
  );
  const planned = useMemo(
    () => (recurring ? plannedByDate(recurring, todayDate, days[0]!, days[days.length - 1]!) : undefined),
    [recurring, todayDate, days],
  );

  /**
   * 한 번 결제한 것이 여러 줄로 갈려 들어온 것(네이버페이 포인트 + 카드)을 한 줄로 묶는다.
   * **취소 짝보다 먼저** — 합쳐 두면 쪼개진 환불도 금액이 맞아 저절로 묶인다 (split-pay.ts).
   */
  const rows = useMemo(() => mergeSplits(txs ?? []), [txs]);

  const byDate = useMemo(() => {
    const map = new Map<string, Transaction[]>();
    for (const tx of rows) map.set(tx.date, [...(map.get(tx.date) ?? []), tx]);
    return map;
  }, [rows]);

  /**
   * 결제·환불 짝은 **달 전체로 한 번에** 맞춘다. 칸마다 그날치로만 맞추면 카드 취소처럼
   * 이틀 뒤에 들어온 환불을 영영 못 묶어, 그 날 칸에 `+19,400` 한 줄만 덩그러니 남는다.
   */
  const cancels = useMemo(() => cancelsOf(rows), [rows]);

  const monthTxs = (txs ?? []).filter((t) => t.date.startsWith(month));
  const monthSpend = spendOf(monthTxs);
  const monthIncome = monthTxs.filter((t) => t.kind === "income").reduce((sum, t) => sum + t.amount, 0);

  const go = (next: { month?: string; date?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.month) {
      p.set("month", next.month);
      if (next.date === undefined) p.delete("date"); // 달을 옮기면 그 달의 기본 날짜로
    }
    if (next.date === null) p.delete("date");
    else if (next.date) p.set("date", next.date);
    setParams(p, { replace: true });
  };

  async function saveMemo(id: number, change: { memo?: string | null; note?: string | null }) {
    const saved = await ledgerApi.setMemo(id, change);
    const tx = txs?.find((t) => t.id === id);
    setTxs((list) => list?.map((t) => (t.id === id ? withSavedMemo(t, saved) : t)) ?? null);
    // 방금 쓴 메모도 바로 자동완성에 나오게
    if (tx && saved.memo && change.memo !== undefined) addMemoUse(tx, saved.memo);
  }

  /** 거래 한 건의 카테고리 바꾸기. 새 카테고리를 만들었으면 목록도 다시 받는다 */
  async function changeCategory(id: number, choice: CategoryChoice): Promise<{ categoryId: number | null; label: string | null }> {
    const created = choice !== null && "newPath" in choice;
    const saved = await ledgerApi.setCategory(id, created ? { newCategory: choice.newPath } : { categoryId: choice?.id ?? null });
    const list = created ? await ledgerApi.categories() : categories;
    if (created) setCategories(list);
    const cat = list.find((c) => c.id === saved.categoryId);
    const parent = cat?.parentId ? list.find((c) => c.id === cat.parentId) : undefined;
    setTxs(
      (all) =>
        all?.map((t) =>
          t.id === id ? { ...t, categoryId: saved.categoryId, category: cat?.name ?? null, categoryGroup: parent?.name ?? cat?.name ?? null } : t,
        ) ?? null,
    );
    return { categoryId: saved.categoryId, label: cat ? cat.label.replace(" > ", " › ") : null };
  }

  return (
    <section className="lg-page">
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
        <div className="lg-toolbar-right">
          <div className="lg-stat">
            <span className="lg-stat-label">이번 달 지출</span>
            <strong className="lg-stat-value hb-secret">{won(monthSpend)}원</strong>
          </div>
          <div className="lg-stat">
            <span className="lg-stat-label">수입</span>
            <strong className="lg-stat-value flow-in hb-secret">{won(monthIncome)}원</strong>
          </div>
          {lost.length > 0 && (
            <button className="lg-lost-hint" onClick={() => go({ month: lost[0]!.date.slice(0, 7), date: lost[0]!.date })} title="엑셀을 넣을 때 어느 결제인지 못 정한 앱알림 메모예요. 눌러서 그날로 가요">
              옮기지 못한 메모 {lost.length}건
            </button>
          )}
        </div>
      </div>

      {error && <p className="hb-error">{error}</p>}

      <div className="lg-layout">
        <MonthGrid
          month={month}
          days={days}
          byDate={byDate}
          today={todayDate}
          selected={selected}
          loading={txs === null}
          onSelect={(date) => go({ date: date === selected ? null : date })}
          planned={planned}
          cancels={cancels}
          recurringIds={recurringIds}
          // 달력 줄을 누르면 그 자리에서 메모·분류 편집 (날짜 상세의 줄과 같은 부품)
          renderPinned={(tx, cancel) => (
            <ul className="lg-rows lg-pin-rows">
              <TxRow
                tx={tx}
                cancel={cancel}
                onSaveMemo={saveMemo}
                categories={categories}
                onChangeCategory={changeCategory}
                memoUses={memoUses}
                onMemosApplied={() => {
                  setReload((n) => n + 1);
                  void refreshMemoUses();
                }}
              />
            </ul>
          )}
        />
        {selected && (
          <DayDetail wide={wide} date={selected} onClose={() => go({ date: null })}>
            <DayPanel
              date={selected}
              txs={byDate.get(selected) ?? []}
              onClose={() => go({ date: null })}
              onSaveMemo={saveMemo}
              categories={categories}
              onChangeCategory={changeCategory}
              memoUses={memoUses}
              planned={planned?.get(selected) ?? []}
              cancels={cancels}
              recurringIds={recurringIds}
              lost={lostByDate.get(selected) ?? []}
              onMemosApplied={() => {
                setReload((n) => n + 1);
                void refreshMemoUses();
              }}
            />
          </DayDetail>
        )}
      </div>
    </section>
  );
}

/**
 * 날짜 상세: PC 는 누른 칸 옆 팝업, 좁은 화면은 달력 아래 그대로.
 *
 * 좁은 화면에서는 **눌렀을 때 그리로 데려간다** — 달력 한 장이 화면보다 길어서, 누르고 나서
 * 아무 일도 안 일어난 것처럼 보였다(상세는 저 아래에 열려 있다).
 */
function DayDetail({ wide, date, onClose, children }: { wide: boolean; date: string; onClose(): void; children: ReactNode }) {
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

/** 날짜 상세를 칸 옆 팝업으로 띄우는 넓은 화면 (ledger.css 의 1100px 기준과 같게) */
function useWide(): boolean {
  const query = "(min-width: 1101px)";
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}
