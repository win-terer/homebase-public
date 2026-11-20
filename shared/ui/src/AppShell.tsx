import { useCallback, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { ContextMenuProvider, type MenuItem } from "./ContextMenu.tsx";
import { HEADER_SLOT_ID } from "./HeaderSlot.tsx";
import { privacyHidden, PrivacyToggle, setPrivacyHidden } from "./privacy.tsx";
import { ThemeToggle } from "./theme.tsx";

export interface NavItem {
  path: string;
  title: string;
}

/**
 * 공통 레이아웃: 상단 바 + 앱 전환 내비게이션.
 *
 * `guest` 면 **동거인 화면**이다 — 다른 앱으로 가는 길과 금액 스위치는 빼고(가계부가 아예 없다)
 * 밝기 스위치와 나가기만 남긴다. 헤더 자체를 안 씌웠더니 다크 모드를 못 껐다(사용자 지적 2026-11-20).
 */
export function AppShell({ nav, children, guest = false }: { nav: NavItem[]; children: ReactNode; guest?: boolean }) {
  const navigate = useNavigate();
  /**
   * 어느 메뉴에 와 있나. `일정`(/calendar) 안에 `사진`(/calendar/photos) 이 들어오면서
   * NavLink 의 기본 판정으로는 **둘 다** 켜진다. 그래서 **제일 길게 맞는 하나**만 켠다
   * — `end` 로 막으면 /calendar/import 처럼 탭이 없는 안쪽 화면에서 아무것도 안 켜진다.
   */
  const { pathname } = useLocation();
  const here = nav
    .filter((item) => pathname === item.path || pathname.startsWith(`${item.path.replace(/\/$/, "")}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;

  /**
   * 아무 데서나 우클릭했을 때 뜨는 메뉴.
   *
   * 브라우저 기본 메뉴를 막으면서 거기서 쓰던 '뒤로·새로고침' 을 잃는다. 그래서 그 둘은
   * 반드시 넣는다 — 막아 놓고 대신 줄 게 없으면 그냥 불편해지기만 한다.
   */
  const fallback = useCallback(
    (): MenuItem[] => [
      { label: "뒤로", onSelect: () => navigate(-1) },
      { label: "새로고침", onSelect: () => window.location.reload() },
      // 손님에게는 가릴 금액이 없다
      ...(guest
        ? []
        : ([{ separator: true }, { label: privacyHidden() ? "금액 보이기" : "금액 가리기", onSelect: () => setPrivacyHidden(!privacyHidden()) }] as MenuItem[])),
    ],
    [navigate, guest],
  );

  return (
    <ContextMenuProvider fallback={fallback}>
    <div className="hb-shell">
      <header className="hb-header">
        {/* 브랜드를 누르면 **첫 메뉴(일정)** 로 간다 — 홈(기기·로그아웃)은 눌러서 갈 자리가 아니다
            (사용자 요청 2026-11-20). 손님은 화면이 하나뿐이라 그대로 "/" */}
        <NavLink to={nav[0]?.path ?? "/"} className="hb-brand" end>
          <span className="hb-brand-mark" aria-hidden="true">
            {/* 파비콘과 같은 집 모양 */}
            <svg viewBox="0 0 64 64" width="18" height="18">
              <path d="M32 13 12 30h6v20h10V38h8v12h10V30h6z" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="hb-brand-name">homebase</span>
        </NavLink>
        {nav.length > 0 && (
          <nav className="hb-nav">
            {nav.map((item) => (
              <Link key={item.path} to={item.path} className={item.path === here ? "active" : undefined}>
                {item.title}
              </Link>
            ))}
          </nav>
        )}
        <div className="hb-header-end">
          {/* 화면이 채워 넣는 자리 (HeaderSlot) — 지금은 접속 표시가 들어온다 */}
          <div id={HEADER_SLOT_ID} className="hb-header-slot" />
          <ThemeToggle />
          {!guest && <PrivacyToggle />}
          {/* 주인은 **한 번 더 묻는다** — 누르면 홈으로 가고 거기서 고른다(이 기기만/모든 기기).
              손님은 볼 게 없으니 바로 내보낸다 (사용자 요청 2026-11-20).
              로그인·로그아웃은 워커가 처리한다 (host/src/worker/auth.ts) — 일반 폼 전송이라 쿠키·리다이렉트가 그대로 동작 */}
          {guest ? (
            <form method="post" action="/guest/logout" className="hb-logout">
              <button type="submit">나가기</button>
            </form>
          ) : (
            <span className="hb-logout">
              <NavLink to="/" end>
                로그아웃
              </NavLink>
            </span>
          )}
        </div>
      </header>
      <main className="hb-main">{children}</main>
    </div>
    </ContextMenuProvider>
  );
}
