import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router";
import { ledgerApi } from "./api.ts";
import { CalendarPage } from "./CalendarPage.tsx";
import { CategoriesPage } from "./CategoriesPage.tsx";
import { ImportPage } from "./ImportPage.tsx";
import { NotifyPage } from "./NotifyPage.tsx";
import { NotifySetupPage } from "./NotifySetupPage.tsx";
import { RecurringPage } from "./RecurringPage.tsx";
import { ReviewPage } from "./ReviewPage.tsx";
import { SearchBox, SearchPage } from "./SearchPage.tsx";
import { StatsPage } from "./StatsPage.tsx";
import { TaxPage } from "./TaxPage.tsx";
import "./ledger.css";

export function LedgerRoot() {
  return (
    <>
      <LedgerTabs />
      <Routes>
        <Route index element={<CalendarPage />} />
        <Route path="stats" element={<StatsPage />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="tax" element={<TaxPage />} />
        <Route path="recurring" element={<RecurringPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="notify" element={<NotifyPage />} />
        <Route path="notify/setup" element={<NotifySetupPage />} />
      </Routes>
    </>
  );
}

/** 가계부 안의 화면 전환 탭. 중첩 라우트 안이라 상대 경로가 어긋나므로 절대 경로를 쓴다 */
const BASE = "/ledger";

function LedgerTabs() {
  const { pathname } = useLocation();
  const [review, setReview] = useState(0);
  useEffect(() => {
    ledgerApi.overview().then((o) => setReview(o.review), () => {});
  }, [pathname]);

  return (
    <nav className="lg-tabs" aria-label="가계부 화면">
      <NavLink to={BASE} end>
        달력
      </NavLink>
      <NavLink to={`${BASE}/stats`}>통계</NavLink>
      <NavLink to={`${BASE}/recurring`}>정기 결제</NavLink>
      <NavLink to={`${BASE}/review`}>
        확인 필요{review > 0 && <span className="lg-tab-count">{review}</span>}
      </NavLink>
      <NavLink to={`${BASE}/tax`}>연말정산</NavLink>
      {/* 검색 화면에서는 그 화면의 입력칸을 쓴다 */}
      {pathname !== `${BASE}/search` && <SearchBox className="lg-tab-search" />}
      {/* 좁은 화면은 입력칸 대신 탭 하나 */}
      <NavLink to={`${BASE}/search`} className="lg-tab-search-link">
        검색
      </NavLink>
      <NavLink to={`${BASE}/notify`} className="lg-tab-end">
        알림
      </NavLink>
      <NavLink to={`${BASE}/import`}>가져오기</NavLink>
      <NavLink to={`${BASE}/categories`}>카테고리</NavLink>
    </nav>
  );
}
