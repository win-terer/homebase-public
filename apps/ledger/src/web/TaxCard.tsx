import { useEffect, useMemo, useState } from "react";
import { ledgerApi, won, type Transaction } from "./api.ts";
import { RefundCard } from "./RefundCard.tsx";
import {
  addUsage,
  classifyUsage,
  estimateDeduction,
  guessPaymentType,
  PAYMENT_TYPE_LABELS,
  yearEndProjection,
  type PaymentType,
} from "./tax.ts";

const salaryKey = (year: string) => `tax.${year}.salary`;
const cashReceiptKey = (year: string) => `tax.${year}.cashReceipt`;
const paymentKey = (method: string) => `payment.${method}`;

/** 연말정산 카드 공제 현황. 총급여와 결제수단 구분은 사용자가 입력하고 DB 설정에만 저장한다 */
export function TaxCard({ year }: { year: string }) {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [editing, setEditing] = useState(false);
  const [showMethods, setShowMethods] = useState(false);
  const [imported, setImported] = useState<{ count: number; total: number } | null>(null);

  useEffect(() => {
    ledgerApi.settings().then(setSettings, () => setSettings({}));
    ledgerApi.transactions(`${year}-01-01`, `${year}-12-31`).then(setTxs, () => setTxs([]));
    ledgerApi.cashReceiptSummary(year).then(setImported, () => setImported(null));
  }, [year]);

  const salary = Number(settings?.[salaryKey(year)] ?? 0);
  const typeOf = (method: string): PaymentType => (settings?.[paymentKey(method)] as PaymentType | undefined) ?? guessPaymentType(method);

  const methods = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of txs) if (t.kind === "expense" && t.paymentMethod) map.set(t.paymentMethod, (map.get(t.paymentMethod) ?? 0) - t.amount);
    return [...map].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  }, [txs]);

  async function save(key: string, value: string | null) {
    await ledgerApi.setSetting(key, value);
    setSettings((s) => {
      const next = { ...(s ?? {}) };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  if (settings === null) return null;

  if (!salary || editing) {
    return (
      <div className="st-card">
        <div className="st-card-head">
          <h2>연말정산 카드 공제 ({year}년)</h2>
          <span className="hb-muted">총급여를 넣으면 계산해요</span>
        </div>
        <SalaryForm
          initial={salary}
          onSave={async (v) => {
            await save(salaryKey(year), String(v));
            setEditing(false);
          }}
          onCancel={salary ? () => setEditing(false) : undefined}
        />
      </div>
    );
  }

  // 현금영수증은 개별 건 대신 홈택스 누계를 입력받아 체크카드와 같은 30% 로 계산한다.
  // 현금영수증은 대부분 간편결제·계좌이체로 이미 기록된 거래라서 그 결제수단은 '공제 안 됨'으로 둬야 두 번 잡히지 않는다.
  // 가져온 현금영수증이 있으면 그 합계를, 없으면 직접 입력한 홈택스 누계를 쓴다
  const hasImported = (imported?.count ?? 0) > 0;
  const cashReceipt = hasImported ? imported!.total : Number(settings[cashReceiptKey(year)] ?? 0);
  const u = classifyUsage(txs, typeOf, salary);
  const e = estimateDeduction({ ...u, debit: u.debit + cashReceipt }, salary);
  const passed = e.remainingToThreshold === 0;

  // 환급 예상용: 남은 달도 최근 3달처럼 쓴다고 보고 연말까지 늘린다
  const lastDate = txs.reduce((m, t) => (t.date > m ? t.date : m), "");
  const p = yearEndProjection(year, lastDate || `${year}-01-01`);
  const recent = classifyUsage(txs.filter((t) => t.date >= p.recentFrom), typeOf, salary);
  const yearEnd = estimateDeduction({ ...addUsage(u, recent, p.remainingRatio), debit: Math.round(u.debit + recent.debit * p.remainingRatio + cashReceipt * (1 + p.elapsedRatio)) }, salary);
  const insuranceSoFar = txs
    .filter((t) => t.kind === "expense" && /보험/.test(`${t.category ?? ""} ${t.categoryGroup ?? ""}`))
    .reduce((sum, t) => sum - t.amount, 0);
  const insuranceGuess = Math.max(0, Math.round(insuranceSoFar * (1 + p.elapsedRatio)));
  const scaleMax = Math.max(e.eligible, e.threshold) * 1.15 || 1;

  return (
    <>
      <div className="st-card tx-card">
        <div className="st-card-head">
          <h2>연말정산 카드 공제 ({year}년)</h2>
          <span className="hb-muted">
            총급여 <span className="hb-secret">{won(salary)}원</span> 기준 추정 ·{" "}
            <button className="tx-link" onClick={() => setEditing(true)}>
              총급여 수정
            </button>
          </span>
        </div>

        <div className="tx-stats">
          <div>
            <span className="st-kpi-label">공제 문턱 (총급여 25%)</span>
            <strong className="hb-secret">{won(e.threshold)}원</strong>
            <span className="st-kpi-sub">{passed ? "문턱 넘음" : `문턱까지 ${won(e.remainingToThreshold)}원 남음`}</span>
          </div>
          <div>
            <span className="st-kpi-label">지금까지 공제액</span>
            <strong className="flow-in hb-secret">{won(e.total)}원</strong>
            <span className="st-kpi-sub">{e.extra > 0 ? `기본 ${won(e.general)} + 추가 ${won(e.extra)}` : `한도 ${won(e.basicLimit)}원`}</span>
          </div>
          <div>
            <span className="st-kpi-label">남은 한도</span>
            <strong className="hb-secret">{won(e.remainingLimit)}원</strong>
            <span className="st-kpi-sub">{e.remainingLimit ? "기본 한도까지" : "기본 한도 다 채움"}</span>
          </div>
          <div>
            <span className="st-kpi-label">지금부터 100만원 쓰면</span>
            <strong className="tx-per1m">
              체크 +{won(e.per1m.debit)} · 신용 +{won(e.per1m.credit)}
            </strong>
            <span className="st-kpi-sub">
              {e.per1m.debit > e.per1m.credit ? "체크카드·현금영수증이 유리" : passed ? "한도가 차서 차이 없음" : "문턱 전에는 신용카드도 같음"}
            </span>
          </div>
        </div>

        <div className="tx-meter" aria-label={`공제 대상 사용액 ${won(e.eligible)}원, 문턱 ${won(e.threshold)}원`}>
          <div className="tx-meter-fill" style={{ width: `${(e.eligible / scaleMax) * 100}%` }} />
          <div className="tx-meter-mark" style={{ left: `${(e.threshold / scaleMax) * 100}%` }}>
            <span>문턱</span>
          </div>
        </div>
        <p className="tx-meter-caption">
          공제 대상 사용액 <strong className="hb-secret">{won(e.eligible)}원</strong>
        </p>

        <table className="tx-table">
          <tbody>
            <tr><th>신용카드</th><td>{won(u.credit)}원</td><td className="hb-muted">15%</td></tr>
            <tr><th>체크카드</th><td>{won(u.debit)}원</td><td className="hb-muted">30%</td></tr>
            <tr>
              <th>
                현금영수증 <span className="hb-muted">{hasImported ? `(가져온 ${imported!.count}건)` : "(홈택스 누계)"}</span>
              </th>
              <td>
                {hasImported ? (
                  `${won(cashReceipt)}원`
                ) : (
                  <InlineNumber value={cashReceipt} onSave={(v) => save(cashReceiptKey(year), v ? String(v) : null)} />
                )}
              </td>
              <td className="hb-muted">30%</td>
            </tr>
            {u.culture > 0 && <tr><th>도서·공연 등</th><td>{won(u.culture)}원</td><td className="hb-muted">30%</td></tr>}
            <tr><th>대중교통</th><td>{won(u.transit)}원</td><td className="hb-muted">40% · 추가 한도</td></tr>
            {u.market > 0 && <tr><th>전통시장</th><td>{won(u.market)}원</td><td className="hb-muted">40% · 추가 한도</td></tr>}
            <tr className="tx-muted"><th>공제 제외 (통신·관리비·공과금·보험 등)</th><td>{won(u.excluded)}원</td><td /></tr>
            <tr className="tx-muted"><th>계좌·페이 (공제 안 됨으로 구분)</th><td>{won(u.none)}원</td><td /></tr>
          </tbody>
        </table>

        <button className="tx-link" onClick={() => setShowMethods(!showMethods)} aria-expanded={showMethods}>
          {showMethods ? "▾" : "▸"} 결제수단 구분 바꾸기
        </button>
        {showMethods && (
          <ul className="tx-methods">
            {methods.map(([m, sum]) => (
              <li key={m}>
                <span className="tx-method-name" title={m}>{m}</span>
                <span className="hb-muted">{won(sum)}원</span>
                <select value={typeOf(m)} onChange={(ev) => void save(paymentKey(m), ev.target.value)}>
                  {(Object.keys(PAYMENT_TYPE_LABELS) as PaymentType[]).map((t) => (
                    <option key={t} value={t}>{PAYMENT_TYPE_LABELS[t]}</option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}

        <p className="st-note">
          추정치예요. 실제 공제는 카드사·국세청 집계로 정해지니 연말에 홈택스 연말정산 미리보기로 확인하세요. {hasImported
            ? "현금영수증은 가져온 목록의 합계로 계산해요. "
            : "현금영수증은 가져오기 화면에서 목록(CSV)을 올리거나, 홈택스 → 현금영수증 → 사용내역 누계조회의 올해 합계를 넣어주세요. "}
          간편결제·계좌는 &lsquo;공제 안 됨&rsquo;으로 둬야 현금영수증과 두 번 잡히지 않아요.
        </p>
      </div>
      <RefundCard year={year} salary={salary} cardDeduction={yearEnd.total} insuranceGuess={insuranceGuess} settings={settings} save={save} />
    </>
  );
}

/** 금액 입력: 누르면 입력칸으로 바뀌고, Enter·포커스 해제 때 저장 (비우면 null) */
export function InlineNumber({
  value,
  onSave,
  placeholder = "예: 1,500,000",
  unit = "원",
  allowZero = false,
}: {
  value: number;
  onSave(v: number | null): Promise<void>;
  placeholder?: string;
  unit?: string;
  allowZero?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  if (!editing) {
    return (
      <button
        className="tx-link"
        onClick={() => {
          setText(value || allowZero ? won(value) : "");
          setEditing(true);
        }}
      >
        {value || allowZero ? `${won(value)}${unit}` : "입력"}
      </button>
    );
  }
  const commit = async () => {
    const digits = text.replace(/[^\d]/g, "");
    await onSave(digits ? Number(digits) : null);
    setEditing(false);
  };
  return (
    <input
      className="tx-inline-input"
      autoFocus
      inputMode="numeric"
      placeholder={placeholder}
      value={text}
      onChange={(ev) => setText(ev.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(ev) => {
        if (ev.key === "Enter" && !ev.nativeEvent.isComposing) ev.currentTarget.blur(); // 한글 조합 중 blur 하면 마지막 글자가 두 번 들어감
        if (ev.key === "Escape") setEditing(false);
      }}
    />
  );
}

function SalaryForm({ initial, onSave, onCancel }: { initial: number; onSave(v: number): Promise<void>; onCancel?: () => void }) {
  const [value, setValue] = useState(initial ? won(initial) : "");
  const n = Number(value.replace(/[^\d]/g, ""));
  return (
    <form
      className="tx-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (n > 0) void onSave(n);
      }}
    >
      <label>
        <span>올해 총급여 (연간)</span>
        <input inputMode="numeric" placeholder="예: 50,000,000" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button className="hb-button" disabled={!n}>저장</button>
      {onCancel && (
        <button type="button" className="hb-button is-secondary" onClick={onCancel}>취소</button>
      )}
      <p className="hb-muted tx-help">
        급여명세서의 지급총액에서 비과세 식대(월 20만원까지)를 뺀 금액 × 12개월이 대략의 총급여예요. 원천징수영수증이 있으면 그 &lsquo;총급여&rsquo;를 넣으면 정확해요. 이 값은 이 컴퓨터의 DB 에만 저장돼요.
      </p>
    </form>
  );
}
