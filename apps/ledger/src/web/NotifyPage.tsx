import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ledgerApi, won, type NotifyOverview, type RecentNotification, type Transaction } from "./api.ts";
import { formatDay } from "./dates.ts";
import { ago, notifyVerdict, seoulStamp, syncVerdict, type Verdict } from "./notify-status.ts";

/**
 * 알림: 폰 알림으로 들어온 것들과, 그 통로가 살아 있는지.
 *
 * 세 가지를 한 화면에 — (1) 폰 알림이 **오고 있나** (2) 알림으로 만든 임시 거래 목록
 * (3) 집 맥북의 자동 가져오기가 **돌고 있나**. 둘 다 조용히 죽는 통로라 "마지막 소식이
 * 언제였나" 가 핵심이다 (notify-status.ts). 서버 조회는 한 번(`/notify/overview`)이고
 * 캐시를 거치지 않는다 — 생존 보고는 데이터 버전을 올리지 않기 때문이다.
 */
export function NotifyPage() {
  const [data, setData] = useState<NotifyOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    ledgerApi.notifyOverview().then((d) => (setData(d), setNow(Date.now())), (e: Error) => setError(e.message));
  }, []);

  return (
    <section className="lg-page nt-page">
      <div className="lg-toolbar">
        <div className="lg-month-nav">
          <h1>알림</h1>
        </div>
        <p className="hb-muted nt-lead">
          폰 알림으로 들어온 거래와, 그 통로가 살아 있는지
          <Link className="nt-setup-link" to="/ledger/notify/setup">
            📱 폰 알림 설정하는 법
          </Link>
        </p>
      </div>
      {error && <p className="hb-error">{error}</p>}
      {data && (
        <>
          <div className="nt-stats">
            <Stat label="마지막 폰 알림" v={notifyVerdict(data.status, now)} />
            <Stat
              label="임시 거래"
              v={{
                level: "ok",
                headline: `${won(data.status.pending)}건`,
                detail: data.status.pending ? "엑셀을 넣으면 확정 데이터로 바뀌어요" : "알림으로 들어온 거래가 지금은 없어요",
              }}
            />
            <Stat label="자동 가져오기 (집 맥북)" v={syncVerdict(data.sync, now)} />
          </div>

          <section className="hb-card nt-card" aria-label="알림으로 추가한 거래">
            <h2 className="hb-card-title">알림으로 추가한 거래</h2>
            <p className="hb-muted nt-hint">
              가맹점은 알림 원문 그대로(결제대행사 이름일 수 있어요), 괄호는 메모예요. 메모·분류는 날짜를 눌러 달력에서 고치면 엑셀이 덮을 때 함께 옮겨요.
            </p>
            {data.provisional.length === 0 ? (
              <p className="hb-muted nt-empty">없음</p>
            ) : (
              <div className="nt-scroll">
                <table className="nt-table">
                  <thead>
                    <tr>
                      <th>날짜</th>
                      <th>시각</th>
                      <th>가맹점</th>
                      <th>분류</th>
                      <th className="num">금액</th>
                      <th>카드</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.provisional.map((t) => (
                      <ProvisionalRow key={t.id} t={t} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="hb-card nt-card" aria-label="최근 받은 알림">
            <h2 className="hb-card-title">최근 받은 알림</h2>
            <p className="hb-muted nt-hint">단축어가 보낸 원문 그대로예요 (최근 {data.recent.length}건). 거래로 못 읽은 건 광고·안내이거나, 아직 모르는 앱의 문구예요.</p>
            {data.recent.length === 0 ? (
              <p className="hb-muted nt-empty">없음</p>
            ) : (
              <ul className="nt-raw">
                {data.recent.map((n) => (
                  <RawRow key={n.id} n={n} now={now} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function Stat({ label, v }: { label: string; v: Verdict }) {
  return (
    <div className={`nt-stat is-${v.level}`}>
      <span className="nt-stat-label">{label}</span>
      <strong className="nt-stat-value">{v.headline}</strong>
      {v.detail && <span className="nt-stat-detail">{v.detail}</span>}
    </div>
  );
}

function ProvisionalRow({ t }: { t: Transaction }) {
  const refund = t.kind === "expense" && t.amount > 0;
  const category = t.category ? (t.categoryGroup && t.categoryGroup !== t.category ? `${t.categoryGroup} › ${t.category}` : t.category) : null;
  return (
    <tr>
      <td className="nt-date">
        <Link to={`/ledger?month=${t.date.slice(0, 7)}&date=${t.date}`}>{formatDay(t.date)}</Link>
      </td>
      <td className="nt-time">{t.time ? t.time.slice(0, 5) : "–"}</td>
      <td className="nt-merchant">
        {/* 알림 원문의 가맹점이 먼저, 메모는 괄호 — 엑셀이 덮을 때 뭐가 뭘 대신하는지 보이게 */}
        {t.merchant}
        {t.memo && <span className="hb-muted"> ({t.memo})</span>}
        {refund && <span className="nt-tag">환불</span>}
      </td>
      <td className="nt-cat">{category ?? <span className="hb-muted">미분류</span>}</td>
      <td className={`num ${t.amount < 0 ? "flow-out" : "flow-in"}`}>
        {t.amount < 0 ? "−" : "+"}
        {won(Math.abs(t.amount))}
      </td>
      <td className="nt-method hb-muted">{t.paymentMethod ?? ""}</td>
    </tr>
  );
}

function RawRow({ n, now }: { n: RecentNotification; now: number }) {
  const head = [n.title, n.subtitle].filter(Boolean).join(" · ");
  return (
    <li className={n.parsed ? "is-parsed" : ""}>
      <span className="nt-raw-when" title={seoulStamp(n.receivedAt)}>
        {ago(n.receivedAt, now)}
      </span>
      <span className="nt-raw-app">{n.app ?? "앱 모름"}</span>
      <span className={`nt-tag ${n.parsed ? "is-parsed" : "is-skipped"}`}>{n.parsed ? "거래 됨" : "읽지 못함"}</span>
      <span className="nt-raw-text">
        {head && <strong>{head} </strong>}
        {n.excerpt}
      </span>
    </li>
  );
}
