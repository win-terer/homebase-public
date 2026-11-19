import { useState } from "react";
import { ledgerApi, won, type CategoryOption, type LostMemo, type Transaction } from "./api.ts";
import type { CategoryChoice } from "./CategoryPicker.tsx";
import { photoApi } from "@homebase/core/photos-web";

interface Props {
  lost: LostMemo[];
  /** 이날 거래 — 어느 결제에 붙일지 고르는 후보 */
  txs: Transaction[];
  categories: CategoryOption[];
  onSaveMemo(id: number, change: { memo?: string | null; note?: string | null }): Promise<void>;
  onChangeCategory(id: number, choice: CategoryChoice): Promise<unknown>;
  /** 붙이거나 지운 뒤 (목록 다시 읽기) */
  onDone(): void;
}

/**
 * 엑셀이 덮으면서 어느 결제인지 못 정해 남겨 둔 앱알림 메모.
 *
 * 가져오기는 날짜·금액으로 짝을 찾는데, 같은 날 같은 금액이 여럿이고 시각도 안 맞으면
 * 자동으로 붙이지 않는다(엉뚱한 데 붙는 것보다 낫다). 그 메모를 여기서 사람이 고른 결제에
 * 붙인다 — 결제 직후 적은 메모는 다시 쓰기 어려우니 버리지 않는다.
 */
export function LostMemos({ lost, txs, categories, onSaveMemo, onChangeCategory, onDone }: Props) {
  if (!lost.length) return null;
  return (
    <section className="lg-lost" aria-label="옮기지 못한 메모">
      <p className="lg-lost-head">
        옮기지 못한 메모 <span className="hb-muted">— 엑셀을 넣을 때 어느 결제인지 못 정했어요. 골라서 붙여 주세요</span>
      </p>
      <ul>
        {lost.map((l) => (
          <LostRow key={l.key} lost={l} txs={txs} categories={categories} onSaveMemo={onSaveMemo} onChangeCategory={onChangeCategory} onDone={onDone} />
        ))}
      </ul>
    </section>
  );
}

function LostRow({ lost: l, txs, categories, onSaveMemo, onChangeCategory, onDone }: Omit<Props, "lost"> & { lost: LostMemo }) {
  // 같은 금액이 먼저, 그중 시각이 같은 게 맨 앞 — 보통 그게 맞는 결제다
  const candidates = [...txs]
    .filter((t) => t.kind !== "transfer")
    .sort((a, b) => Number(b.amount === l.amount) - Number(a.amount === l.amount) || Number(b.time === l.time) - Number(a.time === l.time));
  const [target, setTarget] = useState<number | "">(candidates[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const category = l.categoryId ? categories.find((c) => c.id === l.categoryId)?.label.replace(" > ", " › ") : null;

  const attach = async () => {
    if (target === "") return;
    setBusy(true);
    try {
      if (l.photos) await photoApi.move("ledger", `lost:${l.key}`, target);
      if (l.memo) await onSaveMemo(target, { memo: l.memo });
      if (l.categoryId) await onChangeCategory(target, { id: l.categoryId });
      await ledgerApi.setSetting(l.key, null);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  const drop = async () => {
    setBusy(true);
    try {
      if (l.photos) await photoApi.drop("ledger", `lost:${l.key}`);
      await ledgerApi.setSetting(l.key, null);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      <div className="lg-lost-what">
        {l.memo && <strong>{l.memo}</strong>}
        {category && <span className="lg-lost-cat">{category}</span>}
        {l.photos ? <span className="lg-lost-cat">📷 사진 {l.photos}장</span> : null}
        <span className="hb-muted">
          {l.time ? l.time.slice(0, 5) : "–"} · {l.merchant} · {won(Math.abs(l.amount))}원
        </span>
      </div>
      <div className="lg-lost-actions">
        <select value={target} onChange={(e) => setTarget(e.target.value === "" ? "" : Number(e.target.value))} disabled={busy} aria-label="붙일 결제">
          {candidates.length === 0 && <option value="">이날 결제가 없어요</option>}
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.time ? t.time.slice(0, 5) : "–"} {t.merchant} {won(Math.abs(t.amount))}원
            </option>
          ))}
        </select>
        <button className="lg-text-button" onClick={() => void attach()} disabled={busy || target === ""}>
          붙이기
        </button>
        <button className="lg-text-button is-quiet" onClick={() => void drop()} disabled={busy}>
          지우기
        </button>
      </div>
    </li>
  );
}
