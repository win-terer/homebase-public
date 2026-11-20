/**
 * 동거인 화면의 진입점.
 *
 * **주인 일정 화면을 그대로 쓴다.** 따로 만들었더니 같은 화면을 두 벌 들고 있게 됐고 품질이
 * 뒤처졌다(2026-11-19 사용자 지적 — 달력이 화면을 못 채우고, 날짜 상세가 팝오버가 아니었다).
 * 여기서 길만 손님 쪽으로 돌리고, 화면에서는 가계부·카테고리 편집·가져오기·검색을 뺀다.
 *
 * 가계부 **코드**는 같은 번들에 실린다. 데이터는 서버가 막는다 — 손님 세션으로는 `/api/guest/*`
 * 말고 어디도 열리지 않고(host auth.ts), 그 길은 공유 카테고리를 쿼리에 박는다(server/guest.ts).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { AppShell } from "@homebase/ui";
import { setPhotoBase } from "@homebase/core/photos-web";
import { CalendarRoot } from "@homebase/calendar/web/root";
import { useGuestRoutes } from "@homebase/calendar/web/api";
import "@homebase/ui/styles.css";

const GUEST_NAV = [
  { path: "/", title: "일정" },
  { path: "/photos", title: "사진" },
  { path: "/todo", title: "할 일" },
];

// 일정도 사진도 손님 길로 — 거기서 '공유 카테고리 것인가' 를 매번 다시 본다
useGuestRoutes();
setPhotoBase("/api/guest/photos");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename="/guest">
      {/* 껍데기도 주인 것을 쓴다. 헤더를 뺐더니 밝기 스위치까지 같이 사라졌다(사용자 지적 2026-11-20).
          `guest` 가 메뉴·금액 스위치를 빼고 [로그아웃] 을 [나가기] 로 바꾼다 — 그 둘뿐이다 */}
      {/* 손님 메뉴는 둘뿐 — 일정 · 사진 (가계부는 코드가 아니라 **서버가** 막는다) */}
      <AppShell nav={GUEST_NAV} guest>
        <CalendarRoot guest />
      </AppShell>
    </BrowserRouter>
  </StrictMode>,
);
