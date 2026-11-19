import { useCallback, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router";
import { ContextMenuProvider, type MenuItem } from "./ContextMenu.tsx";
import { privacyHidden, PrivacyToggle, setPrivacyHidden } from "./privacy.tsx";
import { ThemeToggle } from "./theme.tsx";

export interface NavItem {
  path: string;
  title: string;
}

/** 공통 레이아웃: 상단 바 + 앱 전환 내비게이션 */
export function AppShell({ nav, children }: { nav: NavItem[]; children: ReactNode }) {
  const navigate = useNavigate();

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
      { separator: true },
      { label: privacyHidden() ? "금액 보이기" : "금액 가리기", onSelect: () => setPrivacyHidden(!privacyHidden()) },
    ],
    [navigate],
  );

  return (
    <ContextMenuProvider fallback={fallback}>
    <div className="hb-shell">
      <header className="hb-header">
        <NavLink to="/" className="hb-brand">
          <span className="hb-brand-mark" aria-hidden="true">
            {/* 파비콘과 같은 집 모양 */}
            <svg viewBox="0 0 64 64" width="18" height="18">
              <path d="M32 13 12 30h6v20h10V38h8v12h10V30h6z" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="hb-brand-name">homebase</span>
        </NavLink>
        <nav className="hb-nav">
          {nav.map((item) => (
            <NavLink key={item.path} to={item.path}>
              {item.title}
            </NavLink>
          ))}
        </nav>
        <div className="hb-header-end">
          <ThemeToggle />
          <PrivacyToggle />
          {/* 로그인은 워커가 처리한다 (host/src/worker/auth.ts). 일반 폼 전송이라 쿠키·리다이렉트가 그대로 동작 */}
          <form method="post" action="/logout" className="hb-logout">
            <button type="submit">로그아웃</button>
          </form>
        </div>
      </header>
      <main className="hb-main">{children}</main>
    </div>
    </ContextMenuProvider>
  );
}
