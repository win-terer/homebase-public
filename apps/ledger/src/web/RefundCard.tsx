import { useEffect, useState } from "react";
import { ledgerApi, won, type Snapshot } from "./api.ts";
import { estimateMortgageInterest, estimateRefund, isLongTermMortgage, MORTGAGE_LIMIT } from "./tax.ts";
import { InlineNumber } from "./TaxCard.tsx";

const key = (year: string, name: string) => `tax.${year}.${name}`;

interface Props {
  year: string;
  salary: number;
  /** 연말까지 예상한 카드 소득공제액 */
  cardDeduction: number;
  /** 거래 기록에서 찾은 보험료를 연말까지 늘린 값 */
  insuranceGuess: number;
  settings: Record<string, string>;
  save(key: string, value: string | null): Promise<void>;
}

/** 연말정산 예상 환급. 입력값(원천징수 소득세·부양가족·대출 이자·보험료)은 DB 설정에만 저장한다 */
export function RefundCard({ year, salary, cardDeduction, insuranceGuess, settings, save }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => {
    ledgerApi.latestSnapshot().then(setSnapshot, () => setSnapshot(null));
  }, []);

  const stored = (name: string) => settings[key(year, name)];
  const loans = (snapshot?.loans ?? []).filter(isLongTermMortgage);
  const loanInterest = loans.reduce((s, l) => s + estimateMortgageInterest(l, year), 0);
  const mortgageInterest = stored("mortgageInterest") !== undefined ? Number(stored("mortgageInterest")) : loanInterest;
  const insurance = stored("insurance") !== undefined ? Number(stored("insurance")) : insuranceGuess;
  const withheldMonthly = Number(stored("withholdingMonthly") ?? 0);
  const dependents = Number(stored("dependents") ?? 0);

  const e = estimateRefund({ salary, withheldMonthly, dependents, cardDeduction, mortgageInterest, insurance });
  const setNumber = (name: string) => (v: number | null) => save(key(year, name), v === null ? null : String(v));

  return (
    <div className="st-card tx-card rf-card">
      <div className="st-card-head">
        <h2>연말정산 예상 환급 ({year}년)</h2>
        <span className="hb-muted">남은 달도 최근 3달처럼 쓴다고 보고 계산</span>
      </div>

      {!withheldMonthly ? (
        <div className="tx-form">
          <label>
            <span>매달 떼는 소득세 (급여명세서)</span>
            <InlineNumber value={0} placeholder="예: 200,000" onSave={setNumber("withholdingMonthly")} />
          </label>
          <p className="hb-muted tx-help">
            급여명세서 공제 항목의 &lsquo;소득세&rsquo;(지방소득세 말고)를 넣으면 환급액을 계산해요. 이 컴퓨터의 DB 에만 저장돼요.
          </p>
        </div>
      ) : (
        <>
          <div className="rf-headline">
            <span className="st-kpi-label">{e.refund >= 0 ? "돌려받을 돈 (지방소득세 포함)" : "더 낼 돈 (지방소득세 포함)"}</span>
            <strong className={`hb-secret ${e.refund >= 0 ? "flow-in" : "flow-out"}`}>약 {won(Math.abs(e.refund))}원</strong>
            <span className="st-kpi-sub hb-secret">
              낸 세금 {won(e.withheld)}원 − 확정 세금 {won(e.determined)}원
            </span>
          </div>

          <div className="rf-grid">
            <table className="tx-table">
              <caption>입력값</caption>
              <tbody>
                <tr>
                  <th>총급여</th>
                  <td><span className="hb-secret">{won(salary)}원</span></td>
                  <td className="hb-muted">위 카드에서 수정</td>
                </tr>
                <tr>
                  <th>매달 떼는 소득세</th>
                  <td><InlineNumber value={withheldMonthly} onSave={setNumber("withholdingMonthly")} /></td>
                  <td className="hb-muted">× 12개월</td>
                </tr>
                <tr>
                  <th>부양가족 (본인 제외)</th>
                  <td>
                    <InlineNumber value={dependents} unit="명" allowZero onSave={setNumber("dependents")} />
                  </td>
                  <td className="hb-muted">1명당 150만 공제</td>
                </tr>
                <tr>
                  <th>
                    주택담보대출 이자
                    {loans.length > 0 && <span className="hb-muted"> ({loans.map((l) => l.product).join(", ")})</span>}
                  </th>
                  <td>
                    <InlineNumber value={mortgageInterest} allowZero onSave={setNumber("mortgageInterest")} />
                  </td>
                  <td className="hb-muted">
                    {stored("mortgageInterest") !== undefined ? (
                      <button className="tx-link" onClick={() => void save(key(year, "mortgageInterest"), null)}>
                        자동 계산으로
                      </button>
                    ) : loans.length ? (
                      "대출 잔액 × 금리"
                    ) : (
                      "대출 정보 없음"
                    )}
                  </td>
                </tr>
                <tr>
                  <th>보장성 보험료 (연간)</th>
                  <td>
                    <InlineNumber value={insurance} allowZero onSave={setNumber("insurance")} />
                  </td>
                  <td className="hb-muted">
                    {stored("insurance") !== undefined ? (
                      <button className="tx-link" onClick={() => void save(key(year, "insurance"), null)}>
                        기록에서 찾기
                      </button>
                    ) : (
                      "보험 카테고리 기록"
                    )}
                  </td>
                </tr>
              </tbody>
            </table>

            <table className="tx-table rf-steps">
              <caption>계산 과정</caption>
              <tbody>
                <tr><th>총급여</th><td><span className="hb-secret">{won(salary)}</span></td></tr>
                <tr><th>− 근로소득공제</th><td>{won(e.earnedDeduction)}</td></tr>
                <tr className="rf-sub"><th>= 근로소득금액</th><td>{won(e.earnedIncome)}</td></tr>
                <tr><th>− 인적공제 ({1 + dependents}명)</th><td>{won(e.deductions.basic)}</td></tr>
                <tr><th>− 4대보험 (연금·건강·고용)</th><td>{won(e.deductions.pension + e.deductions.health + e.deductions.employ)}</td></tr>
                <tr><th>− 카드 등 사용 공제</th><td>{won(e.deductions.card)}</td></tr>
                {e.deductions.mortgage > 0 && <tr><th>− 주택담보대출 이자</th><td>{won(e.deductions.mortgage)}</td></tr>}
                <tr className="rf-sub"><th>= 과세표준</th><td>{won(e.base)}</td></tr>
                <tr><th>산출세액 (세율 적용)</th><td>{won(e.calc)}</td></tr>
                <tr><th>− 근로소득 세액공제</th><td>{won(e.credits.earned)}</td></tr>
                {e.credits.standard > 0 && <tr><th>− 표준세액공제</th><td>{won(e.credits.standard)}</td></tr>}
                {e.credits.insurance > 0 && <tr><th>− 보험료 세액공제 (12%)</th><td>{won(e.credits.insurance)}</td></tr>}
                <tr className="rf-sub"><th>= 확정 세금</th><td>{won(e.determined)}</td></tr>
              </tbody>
            </table>
          </div>

          <p className="st-note">
            추정치예요. 4대보험은 총급여 × 올해 요율로 계산했어요. 대출 이자는 뱅크샐러드 스냅샷
            {snapshot ? ` (${snapshot.asOf} 기준)` : ""}의 잔액 × 금리 × 올해 낸 달 수이고, 공제 한도는 {won(MORTGAGE_LIMIT / 10_000)}만원으로 봤어요.
            대출 이자를 공제받으면 표준세액공제(13만원)는 못 받고 보험료 세액공제를 대신 받아요.
            정확한 이자는 연말에 은행 &lsquo;주택자금 상환 증명서&rsquo;(홈택스 간소화)로 확인해서 고쳐 넣으면 돼요.
          </p>
        </>
      )}
    </div>
  );
}
