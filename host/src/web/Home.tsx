import { useEffect, useState } from "react";
import { clearWebCache } from "@homebase/core/web-cache";

interface Session {
  expiresAt: string | null;
  devices: number;
  /** 2단계 인증(OTP)을 쓰고 있나 */
  otp: boolean;
}

const formatDate = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));

export function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/api/session")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setSession)
      .catch(() => setError(true));
  }, []);

  return (
    <section className="hb-narrow">
      <h1>homebase</h1>
      {error && <p className="hb-error">서버에 연결할 수 없어요.</p>}
      {/* OTP 를 안 쓰기로 골랐으면 **켜라고 권한다.** 비밀번호 하나로 가계부가 전부 열린다 */}
      {session && !session.otp && (
        <div className="hb-card">
          <h2 className="hb-card-title">2단계 인증이 꺼져 있어요</h2>
          <p className="hb-muted">
            지금은 비밀번호만 맞으면 들어올 수 있어요. 휴대폰 OTP 앱을 함께 쓰면, 비밀번호가 새어도 남이 못 들어옵니다.
          </p>
          <div className="hb-actions">
            <a className="hb-button" href="/setup">
              OTP 켜기
            </a>
          </div>
        </div>
      )}
      {session && (
        <div className="hb-card">
          <h2 className="hb-card-title">로그아웃</h2>
          <p className="hb-muted">
            로그인된 기기 {session.devices}대
            {session.expiresAt && ` · 이 기기는 ${formatDate(session.expiresAt)}까지 유지 (들어올 때마다 30일 연장)`}
          </p>
          {/* 헤더의 [로그아웃] 은 바로 끊지 않고 이 화면으로 보낸다 — 잘못 눌러 30일짜리 로그인을
              날리는 게 제일 곤란하다 (사용자 요청 2026-11-20). 끊는 건 여기 두 버튼뿐이다 */}
          <div className="hb-actions">
            <form method="post" action="/logout" onSubmit={() => clearWebCache() /* 이 브라우저에 남은 가계부 내역도 함께 지운다 */}>
              <button type="submit" className="hb-button">
                이 기기에서 로그아웃
              </button>
            </form>
            <form
              method="post"
              action="/logout-all"
              onSubmit={(e) => {
                if (!window.confirm("모든 기기에서 로그아웃할까요? 이 기기도 다시 로그인해야 해요.")) {
                  e.preventDefault();
                  return;
                }
                clearWebCache();
              }}
            >
              <button type="submit" className="hb-button is-secondary">
                모든 기기에서 로그아웃
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
