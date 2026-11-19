import { countedRows, shownRows } from "./day-view.ts";
import { splitSummary } from "./split-pay.ts";
import { amountView, flowOf, spendOf, splitSmallIncome, won, type CategoryOption, type LostMemo, type ScheduleItem, type Transaction } from "./api.ts";
import { CategoryPicker, type CategoryChoice } from "./CategoryPicker.tsx";
import { formatDay } from "./dates.ts";
import { useHolidays } from "./holidays.ts";
import type { MemoUse } from "./memo-suggest.ts";
import { MemoEditor } from "./MemoEditor.tsx";
import { useCategoryOffer } from "./SameOffer.tsx";
import type { Planned } from "./recurring.ts";
import { Link, useNavigate } from "react-router";
import { useState } from "react";
import { useContextMenu, type MenuItem } from "@homebase/ui";
import { MakePlanDialog } from "./MakePlanDialog.tsx";
import { LostMemos } from "./LostMemos.tsx";
import { PhotoStrip, usePhotoMarks } from "@homebase/core/photos-web";

interface Props {
  date: string;
  txs: Transaction[];
  /** 없으면 닫기 버튼을 숨긴다 */
  onClose?: () => void;
  onSaveMemo(id: number, change: { memo?: string | null; note?: string | null }): Promise<void>;
  categories: CategoryOption[];
  onChangeCategory(id: number, choice: CategoryChoice): Promise<{ categoryId: number | null; label: string | null }>;
  /** 지금까지 쓴 메모 (자동완성) */
  memoUses: MemoUse[];
  /** 같은 결제 여러 건에 메모를 넣은 뒤 (달력 다시 읽기) */
  onMemosApplied(): void;
  /** 이날 정기 결제 예정 */
  planned: Planned[];
  /** 결제·환불 짝 — 달 전체로 맞춰 넘겨받는다 (api.ts pairCancels) */
  cancels: { cancelled: Set<number>; absorbed: Set<number> };
  /** 정기 결제로 나간 거래 — 줄에 '정기' 를 붙인다 */
  recurringIds?: Set<number>;
  /** 이날 일정 (일정 앱) */
  schedule?: ScheduleItem[];
  /** 엑셀이 덮으면서 짝을 못 찾아 남겨 둔 앱알림 메모 (LostMemos.tsx) */
  lost?: LostMemo[];
}

export function DayPanel({ date, txs, onClose, onSaveMemo, categories, onChangeCategory, memoUses, onMemosApplied, planned, cancels, recurringIds, schedule = [], lost = [] }: Props) {
  const holiday = useHolidays([date]).get(date);
  // 소액 수입(1,000원 미만 리워드·이자)은 달력·날짜 상세에서 아예 빼고 통계에서만 본다
  const { main: kept } = splitSmallIncome(txs);
  // 합계·표시 규칙은 day-view.ts 한 곳에 — 일정 달력도 같은 걸 쓴다
  const forSum = countedRows(kept, cancels);
  const spend = spendOf(forSum);
  const flow = flowOf(forSum);
  /**
   * 같은 날 전액 취소는 **원래 결제에 취소선만** 긋고 환불 줄은 숨긴다 — 달력 칸이 이미 그렇게
   * 하고 있었는데 날짜 상세만 두 줄을 다 보여 줬다(사용자 지적 2026-10-06). 취소선이 "했다가
   * 취소됐다" 를 다 말하므로 `+279,000` 한 줄이 더 있어 봐야 읽는 사람을 헷갈리게 할 뿐이다.
   *
   * **데이터는 그대로 둔다** — 지우는 게 아니라 안 그릴 뿐이다.
   */
  const main = shownRows(kept, cancels);

  const income = main.filter((t) => t.kind === "income" && t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const received = main.filter((t) => t.kind === "transfer" && t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const sent = -main.filter((t) => t.kind === "transfer" && t.amount < 0).reduce((s, t) => s + t.amount, 0);

  return (
    <aside className="lg-panel" aria-label={`${formatDay(date)} 기록`}>
      <header className="lg-panel-head">
        <h2>
          {formatDay(date)}
          {flow.in > 0 && <span className="lg-panel-flow flow-in hb-secret">+{won(flow.in)}</span>}
          {flow.out > 0 && <span className="lg-panel-flow flow-out">-{won(flow.out)}</span>}
          {holiday && <span className="lg-panel-holiday">{holiday.join(", ")}</span>}
        </h2>
        {onClose && (
          <button className="lg-icon-button" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        )}
      </header>
      <p className="lg-panel-summary">
        지출 <strong>{won(spend)}</strong>원
        {income > 0 && (
          <>
            {" · 수입 "}
            <span className="hb-secret">{won(income)}원</span>
          </>
        )}
        {received > 0 && (
          <>
            {" · 받은 돈 "}
            <span className="hb-secret">{won(received)}원</span>
          </>
        )}
        {sent > 0 && ` · 보낸 돈 ${won(sent)}원`}
      </p>

      {schedule.length > 0 && (
        <section className="lg-sched-list" aria-label="이날 일정">
          <ul>
            {schedule.map((e) => (
              <li key={e.id} className={`hb-c-${e.color}`}>
                <span className="lg-sched-dot" aria-hidden="true" />
                <span className="lg-sched-time">{e.time}</span>
                <span className="lg-sched-title">
                  {e.title}
                  {e.location && <span className="hb-muted"> · {e.location}</span>}
                </span>
              </li>
            ))}
          </ul>
          <Link to={`/calendar?month=${date.slice(0, 7)}&date=${date}`}>일정에서 열기 →</Link>
        </section>
      )}

      <LostMemos lost={lost} txs={main} categories={categories} onSaveMemo={onSaveMemo} onChangeCategory={onChangeCategory} onDone={onMemosApplied} />

      {main.length === 0 && planned.length === 0 ? (
        <p className="hb-muted">이날은 기록이 없어요.</p>
      ) : (
        <ul className="lg-rows">
          {main.map((tx) => (
            <TxRow key={tx.id} tx={tx} cancel={cancels.cancelled.has(tx.id) ? "original" : null} recurring={recurringIds?.has(tx.id)} onSaveMemo={onSaveMemo} categories={categories} onChangeCategory={onChangeCategory} memoUses={memoUses} onMemosApplied={onMemosApplied} />
          ))}
          {planned.map((p) => (
            <li key={`plan-${p.key}`} className="lg-row is-planned">
              <div className="lg-row-main">
                <span className="lg-time">예정</span>
                <span className="lg-row-merchant">{p.memo || p.name}</span>
                <span className={`lg-amount ${p.direction === "in" ? "tone-in hb-secret" : "tone-spend"}`}>
                  {p.direction === "in" ? "+" : ""}
                  {p.variable ? "약 " : ""}
                  {won(p.amount)}
                </span>
              </div>
              <div className="lg-row-meta">
                <Link to={`/ledger/recurring?key=${encodeURIComponent(p.key)}`}>정기 결제</Link>
                <span>{p.memo ? `· ${p.name}` : p.direction === "in" ? "에서 예상한 입금이에요" : "에서 예상한 결제예요"}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/**
 * 거래 한 줄: 시각·가게·금액 + 분류 선택 + 메모 칸 + 우클릭 메뉴.
 * 날짜 상세와 **달력 줄을 눌렀을 때 뜨는 고정 상자**(CellTip, CalendarPage 의 renderPinned)가 같이 쓴다.
 */
export function TxRow({
  tx,
  onSaveMemo,
  categories,
  onChangeCategory,
  memoUses,
  onMemosApplied,
  cancel,
  recurring,
}: Pick<Props, "onSaveMemo" | "categories" | "onChangeCategory" | "memoUses" | "onMemosApplied"> & {
  tx: Transaction;
  cancel: "original" | "refund" | null;
  /** 정기 결제로 나간 줄인가 */
  recurring?: boolean;
}) {
  const amount = amountView(tx);
  const categoryOffer = useCategoryOffer(tx, onMemosApplied);
  const kindLabel = tx.kind === "income" ? "수입" : tx.kind === "transfer" ? (tx.amount > 0 ? "받은 돈" : "보낸 돈") : null;
  const original = tx.rawMerchant && tx.rawMerchant !== tx.merchant ? `원래 이름 ${tx.rawMerchant}` : null;
  const receipt = tx.cashReceipt && tx.paymentMethod !== "현금영수증" ? "현금영수증 발급" : null;
  const cancelLabel = cancel === "original" ? "취소함" : cancel === "refund" ? "위 결제 취소" : null;
  // 갈려 들어온 결제는 결제수단 자리에 **구성**을 적는다 — `포인트 1,300 + 간편결제 14,000`
  const payment = tx.splitParts ? splitSummary(tx.splitParts) : tx.paymentMethod;
  const meta = [cancelLabel, kindLabel, payment, receipt, original].filter(Boolean).join(" · ");

  // 우클릭 메뉴. 메모·분류는 행 안에 이미 있으니 여기서는 **다른 화면으로 가는 일**만 올린다
  const menu = useContextMenu();
  const navigate = useNavigate();
  const [makePlan, setMakePlan] = useState(false);
  // 사진: 붙은 게 있으면 늘 보이고, 없으면 📷 를 눌렀을 때만 (줄이 길어지지 않게)
  const photoCount = usePhotoMarks("ledger")[String(tx.id)] ?? 0;
  const [photoOpen, setPhotoOpen] = useState(false);
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
  const items: MenuItem[] = [
    { label: "정기 결제로 등록…", hint: "연 1회 결제", onSelect: () => setMakePlan(true) },
    { label: "같은 가게 찾기", onSelect: () => navigate(`/ledger/search?q=${encodeURIComponent(tx.merchant)}`) },
    { separator: true },
    { label: "이름 복사", onSelect: () => copy(tx.merchant) },
    { label: "금액 복사", onSelect: () => copy(String(Math.abs(tx.amount))) },
  ];

  return (
    <li data-photo-target={`ledger:${tx.id}`} className={`lg-row ${tx.provisional ? "is-provisional" : ""} ${cancel ? `is-${cancel === "original" ? "cancelled" : "cancel-refund"}` : ""}`} onContextMenu={(e) => menu(e, items)}>
      <div className="lg-row-main">
        <span className="lg-time">{tx.time ? tx.time.slice(0, 5) : "–"}</span>
        <span className="lg-row-merchant">{tx.merchant}</span>
        {/* 정기 결제로 나간 줄 — 매달 나가는 것인지 한 번뿐인지는 한눈에 보여야 한다(사용자 요청) */}
        {recurring && (
          <span className="lg-tag lg-tag-repeat" title="정기 결제로 잡힌 결제예요. 정기 결제 화면에서 묶어 볼 수 있어요">
            ↻ 정기
          </span>
        )}
        {/* 한 번 결제한 것이 포인트·카드로 갈려 들어와 한 줄로 묶은 것 (split-pay.ts) */}
        {tx.splitParts && (
          <span className="lg-tag lg-tag-split" title="한 번 결제한 것이 여러 줄로 갈려 들어와서 한 줄로 묶었어요">
            ⧉ {tx.splitParts.length}번에 나눠 냄
          </span>
        )}
        {/* 폰 알림으로 먼저 들어온 것 — 가계부 엑셀이 그 기간을 덮으면 확정된다 */}
        {tx.provisional && (
          <span className="lg-tag" title="폰 알림으로 먼저 들어온 기록이에요. 가계부 엑셀을 올리면 확정돼요">
            앱알림
          </span>
        )}
        <span className={`lg-amount tone-${amount.tone} ${amount.tone === "in" ? "hb-secret" : ""}`}>{amount.text}</span>
      </div>
      <div className="lg-row-meta">
        {/* 이체는 통계에 안 들어가서 카테고리를 두지 않는다 */}
        {tx.kind !== "transfer" && (
          <CategoryPicker
            compact
            kind={tx.kind}
            categories={categories}
            value={tx.categoryId ? { id: tx.categoryId } : null}
            onChange={(choice) => void onChangeCategory(tx.id, choice).then(categoryOffer.after)}
          />
        )}
        {/* 메모 낱말로 붙은 태그 — 누르면 그 태그가 붙은 결제를 모아 본다 */}
        {tx.tags?.map((t) => (
          <Link key={t} to={`/ledger/search?q=${encodeURIComponent(`#${t}`)}`} className="lg-tag lg-tag-user" title={`'${t}' 태그가 붙은 결제 모아 보기`}>
            #{t}
          </Link>
        ))}
        {meta && <span>{meta}</span>}
        {!photoCount && !photoOpen && (
          <button type="button" className="hb-photo-toggle" onClick={() => setPhotoOpen(true)} title="사진 붙이기 (영수증 등, 3장까지) — 이 줄을 누른 뒤 Ctrl+V 로 붙여넣어도 돼요">
            📷
          </button>
        )}
      </div>
      {categoryOffer.node}
      <MemoEditor tx={tx} memoUses={memoUses} onSaveMemo={onSaveMemo} onMemosApplied={onMemosApplied} />
      {(photoCount > 0 || photoOpen) && <PhotoStrip app="ledger" refId={tx.id} className="is-compact" autoOpenPicker={photoOpen && !photoCount} />}
      {makePlan && <MakePlanDialog tx={tx} onClose={() => setMakePlan(false)} onDone={onMemosApplied} />}
    </li>
  );
}
