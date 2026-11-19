import { useRef, useState } from "react";
import { amountView, flowOf, hourLabel, labelOf, manWon, shortWon, splitSmallIncome, won, type Transaction } from "./api.ts";
import { countedRows, shownRows } from "./day-view.ts";
import { useCellTip } from "./CellTip.tsx";
import { WEEKDAY_LABELS, weekday } from "./dates.ts";
import { useHolidays } from "./holidays.ts";
import { itemsThatFit, useFillHeight, useWide } from "./fill-height.ts";
import type { Planned } from "./recurring.ts";
import { splitSummary } from "./split-pay.ts";
import type { ReactNode } from "react";
import { PhotoMark, usePhotoMarks } from "@homebase/core/photos-web";
import { Link } from "react-router";

/** 줄 높이를 아직 못 쟀을 때(좁은 화면 등) 쓰는 기본 줄 수 */
const MAX_ITEMS = 5;

interface Props {
  month: string;
  days: string[];
  byDate: Map<string, Transaction[]>;
  today: string;
  selected: string | null;
  loading: boolean;
  onSelect(date: string): void;
  /** 정기 결제 예정 (오늘 이후) */
  planned?: Map<string, Planned[]>;
  /**
   * 결제·환불 짝. **달 전체를 한 번에 맞춰** 넘겨받는다 — 칸마다 그날치로만 맞추면 환불이
   * 다음 날 들어온 것(카드 취소는 이틀씩 밀린다)을 영영 못 묶는다.
   */
  cancels: { cancelled: Set<number>; absorbed: Set<number> };
  /** 정기 결제로 나간 거래 — 줄에 `↻` 표를 단다 */
  recurringIds?: Set<number>;
  /** 줄을 누르면 고정되는 상자 안에 그릴 것 (메모·분류 편집). 없으면 올렸을 때만 보인다 */
  renderPinned?: (tx: Transaction, cancel: "original" | null) => ReactNode;
}

/** 고정 상자가 가리키는 줄: 날짜 + 거래(또는 일정) id (목록이 바뀌어도 id 로 다시 찾는다) */
interface PinKey {
  date: string;
  id: number;
}

export function MonthGrid({ month, days, byDate, today, selected, loading, onSelect, planned, cancels, recurringIds, renderPinned }: Props) {
  const photos = usePhotoMarks("ledger"); // 사진 붙은 거래 → 줄에 작은 카메라
  const holidays = useHolidays(days);
  /**
   * 달력이 화면 바닥까지 닿게 — 일정 달력과 같은 방식(fill-height.ts). 높이를 못 박으므로
   * 넘치는 줄은 잘리고, 몇 줄이 들어가는지(`fit`)를 세어 `+N건 더` 로 알린다.
   */
  const gridEl = useRef<HTMLDivElement>(null);
  const wide = useWide();
  const rowPx = useFillHeight(gridEl, Math.ceil(days.length / 7), wide);
  const fit = itemsThatFit(rowPx, MAX_ITEMS);
  /**
   * `+N건 더` 를 눌러 펼쳐 둔 날짜들. **여러 칸을 동시에** 펼칠 수 있다 (2026-11-12 사용자 요청 —
   * 9일을 펼쳐 보다가 11일을 펼치면 9일이 도로 접혔다). 펼친 칸이 하나라도 있으면 격자가
   * `height: auto` 로 바뀌어 줄마다 필요한 만큼 늘어난다(.lg-grid.is-open).
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggleExpanded = (date: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(date)) next.add(date);
      return next;
    });
  const { bind: tipOn, tip } = useCellTip<PinKey>(
    (key) => {
      if (!renderPinned) return null;
      const txs = byDate.get(key.date) ?? [];
      const tx = txs.find((t) => t.id === key.id);
      return tx ? renderPinned(tx, cancels.cancelled.has(tx.id) ? "original" : null) : null;
    },
    (a, b) => a.date === b.date && a.id === b.id,
  );
  return (
    <div ref={gridEl} className={`lg-grid is-fill ${loading ? "is-loading" : ""} ${expanded.size ? "is-open" : ""}`} role="grid">
      {tip}
      {WEEKDAY_LABELS.map((w, i) => (
        <div key={w} className={`lg-weekday wd-${i}`} role="columnheader">
          {w}
        </div>
      ))}
      {days.map((date) => {
        const txs = byDate.get(date) ?? [];

        const holiday = holidays.get(date);
        // 같은 날 전액 취소한 결제는 원래 결제 한 줄에 취소선 (환불 줄은 숨김)
        const { cancelled, absorbed } = cancels;
        const nonSmall = splitSmallIncome(txs).main;
        // 하루 합계에는 소액 수입도, **취소된 짝도** 넣지 않는다. 결제와 환불이 다른 날이면
        // 환불만 빼고 결제를 남길 수 없다 — 둘 다 빼야 달이 맞는다 (api.ts pairCancels).
        const flow = flowOf(countedRows(nonSmall, cancels));
        const main = shownRows(nonSmall, cancels);
        const all = planned?.get(date) ?? [];
        const open = expanded.has(date);
        const total = main.length + all.length;
        // 다 안 들어가면 마지막 한 줄은 `+N건 더` 몫으로 비운다
        const room = open ? total : total > fit ? fit - 1 : fit;
        const visible = main.slice(0, room);
        const plans = all.slice(0, Math.max(0, room - visible.length));
        const hidden = main.length - visible.length + all.length - plans.length;
        const classes = [
          "lg-cell",
          `wd-${weekday(date)}`,
          date.startsWith(month) ? "" : "is-outside",
          date === today ? "is-today" : "",
          holiday ? "is-holiday" : "",
          date === selected ? "is-selected" : "",
        ].join(" ");
        return (
          <div
            key={date}
            className={classes}
            role="gridcell"
            data-date={date}
            tabIndex={0}
            aria-selected={date === selected}
            onClick={() => onSelect(date)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(date))}
          >
            <div className="lg-cell-head">
              <span className="lg-daynum">{Number(date.slice(8))}</span>
              {holiday && (
                <span className="lg-holiday" title={holiday.join(", ")}>
                  {holiday.join(", ")}
                </span>
              )}
              {(flow.in > 0 || flow.out > 0) && (
                <span className="lg-daytotals">
                  {flow.in > 0 && (
                    <span className="flow-in hb-secret" title="들어온 돈">
                      <span className="lg-full">+{won(flow.in)}</span>
                      <span className="lg-short">+{shortWon(flow.in)}</span>
                    </span>
                  )}
                  {flow.out > 0 && (
                    <span className="flow-out" title="나간 돈">
                      <span className="lg-full">-{won(flow.out)}</span>
                      <span className="lg-short">-{shortWon(flow.out)}</span>
                    </span>
                  )}
                </span>
              )}
            </div>
            <ul className="lg-items">
              {visible.map((tx) => {
                const amount = amountView(tx);
                return (
                  <li
                    key={tx.id}
                    className={`lg-item tone-${amount.tone} ${tx.provisional ? "is-provisional" : ""} ${cancelled.has(tx.id) ? "is-cancelled" : ""} ${recurringIds?.has(tx.id) ? "is-recurring" : ""}`}
                    {...tipOn(
                      {
                        title: labelOf(tx),
                        tags: [tx.provisional ? "앱" : null, cancelled.has(tx.id) ? "취소함" : null, recurringIds?.has(tx.id) ? "정기" : null, tx.splitParts ? `${tx.splitParts.length}번에 나눠 냄` : null, photos[String(tx.id)] ? `사진 ${photos[String(tx.id)]}` : null, ...(tx.tags ?? []).map((t) => `#${t}`)].filter((t): t is string => !!t),
                        lines: [
                          tx.memo ? `가게 · ${tx.merchant}` : null,
                          [tx.time?.slice(0, 5), tx.splitParts ? splitSummary(tx.splitParts) : tx.paymentMethod].filter(Boolean).join(" · ") || null,
                          <span key="amt" className={`lg-tip-amount tone-${amount.tone} ${amount.tone === "in" ? "hb-secret" : ""}`}>
                            {amount.text}원
                          </span>,
                          tx.category ? (tx.categoryGroup && tx.categoryGroup !== tx.category ? `${tx.categoryGroup} › ${tx.category}` : tx.category) : "미분류",
                          tx.provisional ? "폰 알림으로 먼저 들어온 기록 · 엑셀을 올리면 확정돼요" : null,
                        ],
                        note: tx.note,
                      },
                      renderPinned ? { date, id: tx.id } : undefined,
                    )}
                  >
                    {/* 달력이 좁으면 `07:48` 대신 `7시` (ledger.css 의 @container). 칸마다가 아니라 달력 전체 폭 기준 */}
                    {tx.time && (
                      <span className="lg-time">
                        <span className="lg-time-full">{tx.time.slice(0, 5)}</span>
                        <span className="lg-time-hour">{hourLabel(tx.time)}</span>
                      </span>
                    )}
                    {/* 정기 결제로 나간 줄 — 글자 하나로 티만 낸다(칸이 좁아 꼬리표를 달 자리가 없다) */}
                    {recurringIds?.has(tx.id) && (
                      <span className="lg-repeat" aria-hidden="true">
                        ↻
                      </span>
                    )}
                    {/* 한 번 결제한 것이 포인트·카드로 갈려 들어와 한 줄로 묶은 것 (split-pay.ts) */}
                    {tx.splitParts && (
                      <span className="lg-split" aria-hidden="true">
                        ⧉
                      </span>
                    )}
                    <span className={`lg-label ${tx.memo ? "has-memo" : ""}`}>{labelOf(tx)}</span>
                    <PhotoMark n={photos[String(tx.id)]} />
                    {/* 달력이 넓으면 원 단위(17,500), 좁으면 만 원 단위(1.75) — 시각과 같은 @container 기준 */}
                    <span className={`lg-amount ${amount.tone === "in" ? "hb-secret" : ""}`}>
                      {amount.sign}
                      <span className="lg-won-full">{won(Math.abs(tx.amount))}</span>
                      <span className="lg-won-man">{manWon(Math.abs(tx.amount))}</span>
                    </span>
                  </li>
                );
              })}
              {plans.map((p) => (
                <li
                  key={`plan-${p.key}`}
                  className={`lg-item is-planned ${p.direction === "in" ? "tone-in" : "tone-spend"}`}
                  {...tipOn({
                    title: p.memo || p.name,
                    tags: [p.direction === "in" ? "입금 예정" : "결제 예정"],
                    lines: [
                      p.memo ? `정기 결제 · ${p.name}` : null,
                      <span key="amt" className={`lg-tip-amount ${p.direction === "in" ? "tone-in hb-secret" : "tone-spend"}`}>
                        {p.variable ? "약 " : ""}
                        {p.direction === "in" ? "+" : ""}
                        {won(p.amount)}원
                      </span>,
                      p.variable ? "금액이 매번 달라요 (최근 3번 평균)" : null,
                    ],
                  })}
                >
                  {/* 예정은 정기 결제 메모가 있으면 메모로 (지난 기록은 원래 이름) */}
                  <span className="lg-label">{p.memo || p.name}</span>
                  <span className={`lg-amount ${p.direction === "in" ? "hb-secret" : ""}`}>
                    {p.direction === "in" ? "+" : ""}
                    {p.variable ? "약 " : ""}
                    <span className="lg-won-full">{won(p.amount)}</span>
                    <span className="lg-won-man">{manWon(p.amount)}</span>
                  </span>
                </li>
              ))}
              {/* 칸 어디를 눌러도 날짜 상세가 뜨니 이 줄도 그냥 칸 클릭에 맡긴다 */}
              {(hidden > 0 || open) && (
                <li>
                  <button
                    type="button"
                    className="lg-more cal-more"
                    onClick={(e) => {
                      e.stopPropagation(); // 칸을 누른 걸로 치면 날짜 상세가 열린다
                      toggleExpanded(date);
                    }}
                  >
                    {open ? "접기" : `+${hidden}건 더`}
                  </button>
                </li>
              )}
            </ul>
            {main.length > 0 && <span className="lg-count">{main.length}건</span>}
          </div>
        );
      })}
    </div>
  );
}
