import { useEffect, useState } from "react";
import { clearWebCache } from "@homebase/core/web-cache";

interface Session {
  expiresAt: string | null;
  devices: number;
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
      {session && (
        <div className="hb-card">
          <h2 className="hb-card-title">로그인</h2>
          <p className="hb-muted">
            로그인된 기기 {session.devices}대
            {session.expiresAt && ` · 이 기기는 ${formatDate(session.expiresAt)}까지 유지 (들어올 때마다 30일 연장)`}
          </p>
          <form
            method="post"
            action="/logout-all"
            onSubmit={(e) => {
              if (!window.confirm("모든 기기에서 로그아웃할까요? 이 기기도 다시 로그인해야 해요.")) {
                e.preventDefault();
                return;
              }
              // 이 브라우저에 남은 가계부 내역도 함께 지운다
              clearWebCache();
            }}
          >
            <button type="submit" className="hb-button is-secondary">
              모든 기기에서 로그아웃
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
