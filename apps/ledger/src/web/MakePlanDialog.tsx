import { useState, type FormEvent } from "react";
import { ledgerApi, type Transaction } from "./api.ts";

/**
 * 결제 한 줄 → 직접 등록한 정기 결제.
 *
 * 1년에 한 번 나가는 돈(도메인 갱신·연간 구독)은 저절로는 안 잡힌다 — 정기 결제는 실제 내역에서
 * 찾아내는 것이라 같은 이름이 두 번은 나와야 하고, 연 1회면 두 번째가 1년 뒤다.
 *
 * 등록해 두면 정기 결제 목록에 뜨고 **달력에도 '예정' 으로 저절로 뜬다**(달력의 예정은 정기
 * 결제 목록에서 뽑는다). 그래서 달력 일정을 따로 만들지 않는다 — 그러면 같은 게 두 번 보인다.
 */

const PERIODS = [
  { value: "year", label: "매년" },
  { value: "month", label: "매달" },
  { value: "bimonth", label: "2달마다" },
  { value: "week", label: "매주" },
] as const;

/** 기준일 기본값: 이 결제의 한 주기 뒤 (연간이면 내년 같은 날) */
function nextTurn(date: string, period: string): string {
  const y = +date.slice(0, 4);
  const m0 = +date.slice(5, 7) - 1;
  const d = +date.slice(8, 10);
  if (period === "week") return new Date(Date.UTC(y, m0, d + 7)).toISOString().slice(0, 10);
  const add = period === "month" ? 1 : period === "bimonth" ? 2 : 12;
  const last = new Date(Date.UTC(y, m0 + add + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m0 + add, Math.min(d, last))).toISOString().slice(0, 10);
}

export function MakePlanDialog({ tx, onClose, onDone }: { tx: Transaction; onClose(): void; onDone(): void }) {
  const [name, setName] = useState(tx.memo || tx.merchant);
  const [period, setPeriod] = useState<string>("year");
  const [date, setDate] = useState(() => nextTurn(tx.date, "year"));
  const [amount, setAmount] = useState(String(Math.abs(tx.amount)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 주기를 바꾸면 기준일도 그 주기에 맞춰 따라간다 (직접 고친 뒤에는 건드리지 않게 되길 바라지만,
  // 주기를 바꾼다는 건 보통 날짜도 다시 잡는다는 뜻이다)
  const changePeriod = (next: string) => {
    setPeriod(next);
    setDate(nextTurn(tx.date, next));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const won = Math.round(Math.abs(Number(amount)));
    if (!Number.isFinite(won) || won <= 0) {
      setError("금액을 올바르게 적어 주세요.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await ledgerApi.setSetting(
        `recurring.plan.${name.trim()}`,
        JSON.stringify({ amount: won, period, startDate: date, direction: tx.amount > 0 ? "in" : "out", categoryId: tx.categoryId }),
      );
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "등록하지 못했어요.");
      setSaving(false);
    }
  }

  return (
    <div className="lg-dim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="lg-dialog" onSubmit={submit} role="dialog" aria-label="정기 결제로 등록">
        <h2>정기 결제로 등록</h2>
        <p className="hb-muted">연 1회처럼 드문 결제는 내역만으로는 못 찾아요. 등록해 두면 정기 결제 목록과 달력에 예정으로 보여요.</p>

        <label>
          이름
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
        </label>

        <div className="lg-dialog-row">
          <label>
            주기
            <select value={period} onChange={(e) => changePeriod(e.target.value)}>
              {PERIODS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            다음 결제일
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
        </div>

        <label>
          금액 (원)
          <input type="number" inputMode="numeric" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>

        {error && <p className="hb-error">{error}</p>}

        <div className="lg-dialog-end">
          <button type="button" className="hb-button is-secondary" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="hb-button" disabled={saving}>
            {saving ? "등록하는 중…" : "등록"}
          </button>
        </div>
      </form>
    </div>
  );
}
