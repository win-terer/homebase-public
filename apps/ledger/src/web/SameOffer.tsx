import { useState } from "react";
import { ledgerApi, won, type Transaction } from "./api.ts";

/**
 * "같은 가게·같은 금액 N건에도 넣을까?" 안내 (메모·카테고리 공용).
 * 금액이 다르면 같은 가게여도 묻지 않는다 (사용자 결정: 결제대행사 이름은 여러 가게가 씀).
 */
export function SameOffer({
  children,
  onApply,
  onDismiss,
  actionLabel = "넣기",
}: {
  children: React.ReactNode;
  onApply(remember: boolean): void;
  onDismiss(): void;
  actionLabel?: string;
}) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="lg-memo-offer" role="status">
      <span>{children}</span>
      <div className="lg-memo-offer-actions">
        <label>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> 앞으로도 자동으로
        </label>
        <button type="button" className="hb-button" onClick={() => onApply(remember)}>
          {actionLabel}
        </button>
        <button type="button" className="lg-text-button" onClick={onDismiss}>
          괜찮아
        </button>
      </div>
    </div>
  );
}

/** 카테고리를 바꾼 뒤 "같은 가게·같은 금액 N건도 바꿀까?" (날짜 상세·검색 결과 공용) */
export function useCategoryOffer(tx: Transaction, onApplied: () => void) {
  const raw = tx.rawMerchant ?? tx.merchant;
  const [offer, setOffer] = useState<{ categoryId: number; label: string; count: number } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  async function after(saved: { categoryId: number | null; label: string | null }) {
    setApplied(null);
    if (saved.categoryId === null || tx.kind === "transfer") return setOffer(null);
    const similar = await ledgerApi.similarCategory(raw, tx.amount, saved.categoryId).catch(() => null);
    setOffer(similar && similar.sameAmount > 0 ? { categoryId: saved.categoryId, label: saved.label ?? "", count: similar.sameAmount } : null);
  }

  async function apply(remember: boolean) {
    if (!offer) return;
    const { updated } = await ledgerApi.applyCategory({ merchant: raw, amount: tx.amount, categoryId: offer.categoryId, remember });
    setOffer(null);
    setApplied(`${updated}건을 '${offer.label}'(으)로 바꿨어요${remember ? ". 앞으로 가져오는 같은 결제도 이 카테고리로 넣을게요" : ""}`);
    onApplied();
  }

  const node = (
    <>
      {offer && (
        <SameOffer actionLabel="바꾸기" onApply={(remember) => void apply(remember)} onDismiss={() => setOffer(null)}>
          같은 가게·같은 금액({won(Math.abs(tx.amount))}원)인데 다른 카테고리인 결제 <strong>{offer.count}건</strong>도 &lsquo;{offer.label}&rsquo;(으)로 바꿀까?
          <span className="hb-muted"> (직접 고른 건 그대로)</span>
        </SameOffer>
      )}
      {applied && <p className="lg-memo-applied">{applied}</p>}
    </>
  );
  return { after, node };
}
