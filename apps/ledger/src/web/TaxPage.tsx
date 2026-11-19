import { useSearchParams } from "react-router";
import { TaxCard } from "./TaxCard.tsx";
import { today } from "./dates.ts";

/** 연말정산: 카드 공제 추정 + 예상 환급. 통계(주간·월간·연간)와 상관없이 해마다 하나라 따로 둔다 */
export function TaxPage() {
  const [params, setParams] = useSearchParams();
  const thisYear = today().slice(0, 4);
  const year = /^\d{4}$/.test(params.get("year") ?? "") ? params.get("year")! : thisYear;
  const go = (y: number) => setParams(String(y) === thisYear ? {} : { year: String(y) }, { replace: true });

  return (
    <section className="lg-page st-page">
      <div className="lg-toolbar">
        <div className="lg-month-nav">
          <h1 className="st-title">{year}년 연말정산</h1>
          <div className="lg-nav-group">
            <button className="lg-icon-button" onClick={() => go(Number(year) - 1)} aria-label="이전 해">
              ‹
            </button>
            <button className="lg-text-button" disabled={year === thisYear} onClick={() => go(Number(thisYear))}>
              올해
            </button>
            <button className="lg-icon-button" onClick={() => go(Number(year) + 1)} aria-label="다음 해">
              ›
            </button>
          </div>
        </div>
      </div>
      <div className="st-body">
        <TaxCard year={year} />
      </div>
    </section>
  );
}
