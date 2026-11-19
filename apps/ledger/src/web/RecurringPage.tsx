import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ledgerApi, won } from "./api.ts";
import { addMonths, formatDay, formatMonth, monthGrid, today, WEEKDAY_LABELS, weekday } from "./dates.ts";
import { dueDate, monthEntries, periodLabel, type MonthEntry, type RecurringItem, type RecurringResult } from "./recurring.ts";

/**
 * 정기 결제: 왼쪽은 정기 결제만 보이는 달력(이미 나감 ● / 예정 ○), 오른쪽은 그 달 목록 → 누르면 상세.
 * 같은 이름으로 거의 같은 간격마다 나간(들어온) 돈을 서버가 찾는다 (server/recurring.ts).
 */
export function RecurringPage() {
  const [params, setParams] = useSearchParams();
  const todayDate = today();
  const month = params.get("month") ?? todayDate.slice(0, 7);
  const selectedKey = params.get("key");
  const [data, setData] = useState<RecurringResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => ledgerApi.recurring().then(setData, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const go = (next: { month?: string; key?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.month) p.set("month", next.month);
    if (next.key === null) p.delete("key");
    else if (next.key) p.set("key", next.key);
    setParams(p, { replace: true });
  };

  const items = data?.items ?? [];
  const entries = useMemo(() => monthEntries(items, month, todayDate), [items, month, todayDate]);
  const byDate = useMemo(() => {
    const map = new Map<string, MonthEntry[]>();
    for (const e of entries) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return map;
  }, [entries]);
  const days = useMemo(() => monthGrid(month), [month]);
  const selected = items.find((i) => i.key === selectedKey) ?? null;

  const setting = async (key: string, value: string | null) => {
    await ledgerApi.setSetting(key, value);
    await load();
  };
  // 뺀 곳 되돌리기는 누르자마자 목록에서 뺀다 (다시 불러오기가 몇 초 걸릴 수 있음)
  const [moving, setMoving] = useState<Set<string>>(new Set());
  const move = (key: string, setKey: string, value: string | null) => {
    setMoving((s) => new Set(s).add(key));
    void setting(setKey, value).finally(() =>
      setMoving((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      }),
    );
  };
  const ignored = (data?.ignored ?? []).filter((c) => !moving.has(c.key));

  return (
    <section className="lg-page rc-page">
      <div className="lg-toolbar">
        <div className="lg-month-nav">
          <h1>{formatMonth(month)} 정기 결제</h1>
          <div className="lg-nav-group">
            <button className="lg-icon-button" onClick={() => go({ month: addMonths(month, -1) })} aria-label="이전 달">
              ‹
            </button>
            <button className="lg-text-button" disabled={month === todayDate.slice(0, 7)} onClick={() => go({ month: todayDate.slice(0, 7) })}>
              이번 달
            </button>
            <button className="lg-icon-button" onClick={() => go({ month: addMonths(month, 1) })} aria-label="다음 달">
              ›
            </button>
          </div>
        </div>
      </div>
      {error && <p className="hb-error">{error}</p>}

      <div className="rc-layout">
        <div className="lg-grid rc-grid" role="grid">
          {WEEKDAY_LABELS.map((w, i) => (
            <div key={w} className={`lg-weekday wd-${i}`} role="columnheader">
              {w}
            </div>
          ))}
          {days.map((date) => {
            const list = byDate.get(date) ?? [];
            return (
              <div
                key={date}
                className={`lg-cell rc-cell wd-${weekday(date)} ${date.startsWith(month) ? "" : "is-outside"} ${date === todayDate ? "is-today" : ""}`}
                role="gridcell"
              >
                <div className="lg-cell-head">
                  <span className="lg-daynum">{Number(date.slice(8))}</span>
                </div>
                <ul className="lg-items">
                  {list.map((e) => (
                    <li
                      key={`${e.item.key}-${e.state}`}
                      className={`lg-item rc-item is-${e.state} ${e.item.direction === "in" ? "tone-in" : ""} ${selectedKey === e.item.key ? "is-current" : ""}`}
                      onClick={() => go({ key: e.item.key })}
                      title={[e.item.name, e.item.memo].filter(Boolean).join(" · ")}
                    >
                      <span className="rc-dot" aria-hidden="true" />
                      <span className="lg-label">{e.state !== "paid" && e.item.memo ? e.item.memo : e.item.name}</span>
                      <span className={`lg-amount ${e.item.direction === "in" ? "hb-secret" : ""}`}>{won(e.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <aside className="rc-side">
          {selected ? (
            <Detail
              key={selected.key}
              r={selected}
              names={data?.names ?? []}
              onBack={() => go({ key: null })}
              onSetting={setting}
            />
          ) : (
            <MonthList entries={entries} items={items} onPick={(key) => go({ key })} loading={!data} />
          )}
        </aside>
      </div>

      {ignored.length > 0 && (
        <details className="rc-extra">
          <summary>정기 아님으로 뺀 곳 {ignored.length}개</summary>
          <ul>
            {ignored.map((c) => (
              <li key={c.key}>
                <span>{c.name}</span>
                <button className="lg-text-button" onClick={() => move(c.key, `recurring.ignore.${c.key}`, null)}>
                  되돌리기
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function MonthList({ entries, items, onPick, loading }: { entries: MonthEntry[]; items: RecurringItem[]; onPick(key: string): void; loading: boolean }) {
  const out = entries.filter((e) => e.item.direction === "out");
  const inc = entries.filter((e) => e.item.direction === "in");
  const sum = (list: MonthEntry[]) => list.reduce((s, e) => s + e.amount, 0);
  const paid = sum(out.filter((e) => e.state === "paid"));
  const total = sum(out);
  const shown = new Set(entries.map((e) => e.item.key));
  const elsewhere = items.filter((i) => !shown.has(i.key));
  if (loading) return <p className="hb-muted">불러오는 중…</p>;
  return (
    <>
      <div className="rc-summary">
        <div>
          <span className="lg-stat-label">이번 달 나가는 정기 결제</span>
          <strong className="hb-secret">약 {won(total)}원</strong>
        </div>
        <div className="rc-summary-sub">
          나감 <span className="hb-secret">{won(paid)}</span> · 남음 <span className="hb-secret">{won(total - paid)}</span>
          {inc.length > 0 && (
            <>
              {" · 들어옴 "}
              <span className="hb-secret flow-in">+{won(sum(inc))}</span>
            </>
          )}
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="hb-muted">이 달에는 정기 결제가 없어요.</p>
      ) : (
        <ul className="rc-list">
          {entries.map((e) => (
            <li key={`${e.item.key}-${e.date}-${e.state}`}>
              <button className={`rc-list-row is-${e.state}`} onClick={() => onPick(e.item.key)}>
                <span className="rc-state" aria-label={e.state === "paid" ? "나감" : e.state === "missed" ? "안 나감" : "예정"}>
                  {e.state === "paid" ? "✓" : e.state === "missed" ? "⚠" : "○"}
                </span>
                <span className="rc-day">{Number(e.date.slice(8))}일</span>
                <span className="rc-name">
                  {e.item.name}
                  {e.item.memo && <span className="rc-memo">{e.item.memo}</span>}
                  {e.state === "missed" && <span className="rc-warn">예상일이 지났는데 안 나갔어요 · 해지했나요?</span>}
                  {e.state === "paid" && e.item.changedFrom !== null && e.date === e.item.lastDate && (
                    <span className="rc-warn">{won(e.item.changedFrom)}원에서 바뀜</span>
                  )}
                </span>
                <span className={`rc-amount ${e.item.direction === "in" ? "flow-in hb-secret" : ""}`}>
                  {e.item.direction === "in" ? "+" : ""}
                  {e.state !== "paid" && e.item.variable ? "약 " : ""}
                  {won(e.amount)}
                  {e.item.variable && <span className="rc-tag">변동</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {elsewhere.length > 0 && (
        <details className="rc-elsewhere">
          <summary>이 달엔 없는 정기 결제 {elsewhere.length}개</summary>
          <ul className="rc-list">
            {elsewhere.map((i) => (
              <li key={i.key}>
                <button className="rc-list-row" onClick={() => onPick(i.key)}>
                  <span className="rc-state" />
                  <span className="rc-day" />
                  <span className="rc-name">
                    {i.name}
                    <span className="rc-memo">{periodLabel(i)} · 다음 {formatDay(dueDate(i, i.nextDate))}</span>
                  </span>
                  <span className="rc-amount">{won(i.expected)}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Detail({ r, names, onBack, onSetting }: { r: RecurringItem; names: string[]; onBack(): void; onSetting(key: string, value: string | null): Promise<void> }) {
  const [memo, setMemo] = useState(r.memo ?? "");
  const [merge, setMerge] = useState("");
  const max = Math.max(...r.history.map((h) => h.amount), 1);
  const saveMemo = () => {
    const next = memo.trim();
    if (next !== (r.memo ?? "")) void onSetting(`recurring.memo.${r.key}`, next || null);
  };
  const mergeOptions = names.filter((n) => n !== r.key && !r.aliases.includes(n));
  return (
    <div className="rc-detail">
      <button className="rc-back" onClick={onBack}>
        ← 목록
      </button>
      <h2>
        {r.name}
        {r.kind === "transfer" && <span className="rc-tag">{r.review ? "이체 · 확인 필요" : "이체"}</span>}
        {r.direction === "in" && <span className="rc-tag">들어오는 돈</span>}
        {r.variable && <span className="rc-tag">변동</span>}
      </h2>
      <dl className="rc-facts">
        <dt>주기</dt>
        <dd>{r.plan ? `${periodLabel(r)} · 직접 등록` : `${periodLabel(r)} · ${r.count}번`}</dd>
        <dt>다음 예상</dt>
        <dd>
          {r.missed ? (
            <span className="rc-warn">{formatDay(dueDate(r, r.nextDate))}에 안 나감 · 해지했나요?</span>
          ) : (
            `${formatDay(dueDate(r, r.nextDate))}${r.irregular ? " 쯤" : ""}`
          )}
          {r.shift && dueDate(r, r.nextDate) !== r.nextDate && (
            <span className="hb-muted"> ({formatDay(r.nextDate)}이 쉬는 날이라 {r.shift === "before" ? "앞당김" : "미룸"})</span>
          )}
          {" · "}
          <span className={r.direction === "in" ? "hb-secret" : ""}>
            {r.variable ? "약 " : ""}
            {won(r.expected)}원
          </span>
          {r.variable && (
            <span className="hb-muted">
              {" "}
              (최근 {won(r.range[0])}~{won(r.range[1])})
            </span>
          )}
        </dd>
        <dt>카테고리</dt>
        <dd>{r.category ?? "미분류"}</dd>
        <dt>한 달에</dt>
        <dd className={r.direction === "in" ? "hb-secret" : ""}>약 {won(r.monthly)}원</dd>
      </dl>

      <label className="rc-memo-field">
        <span>메모</span>
        <input value={memo} maxLength={200} placeholder="예: 12월에 해지할 것, 자동이체 계좌" onChange={(e) => setMemo(e.target.value)} onBlur={saveMemo} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()} />
      </label>

      {r.plan ? (
        <p className="hb-muted">직접 등록한 결제예요. 실제 내역이 쌓이면 그쪽을 먼저 보여주니, 그때 이 등록은 지우면 돼요.</p>
      ) : (
        <>
        <h3>지난 내역</h3>
        <ul className="rc-history">
          {r.history.map((h) => (
            <li key={h.id}>
              <Link to={`/ledger?month=${h.date.slice(0, 7)}&date=${h.date}`}>
                {formatDay(h.date)} <span className="hb-muted">{h.date.slice(0, 4)}</span>
              </Link>
              <span className="rc-history-mid">
                {/* 합친 다른 이름으로 나간 건 이름을 같이 */}
                {h.name && h.name !== r.name && <span className="rc-history-name">{h.name}</span>}
                <span className="rc-bar">
                  <span style={{ width: `${Math.max(2, (h.amount / max) * 100)}%` }} />
                </span>
              </span>
              <span className={`rc-amount ${r.direction === "in" ? "hb-secret" : ""}`}>{won(h.amount)}</span>
            </li>
          ))}
        </ul>

        <h3>이름이 바뀐 같은 결제 합치기</h3>
        {r.aliases.length > 0 && (
          <ul className="rc-aliases">
            {r.aliases.map((a) => (
              <li key={a}>
                {a}
                <button className="lg-text-button" onClick={() => void onSetting(`recurring.alias.${a}`, null)}>
                  분리
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="rc-merge">
          <input list={`rc-names-${r.key}`} value={merge} placeholder="다른 이름 (예: 바뀐 입금 계좌 이름)" onChange={(e) => setMerge(e.target.value)} />
          <datalist id={`rc-names-${r.key}`}>
            {mergeOptions.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <button
            className="lg-text-button"
            disabled={!merge.trim() || merge.trim() === r.key}
            onClick={() => {
              void onSetting(`recurring.alias.${merge.trim()}`, r.key);
              setMerge("");
            }}
          >
            합치기
          </button>
        </div>
        </>
      )}

      <div className="rc-detail-actions">
        {r.plan ? (
          <button className="lg-text-button" onClick={() => void onSetting(`recurring.plan.${r.name}`, null).then(onBack)}>
            등록 지우기
          </button>
        ) : r.manual ? (
          <button className="lg-text-button" onClick={() => void onSetting(`recurring.include.${r.key}`, null).then(onBack)}>
            정기 표시 취소
          </button>
        ) : (
          <button className="lg-text-button" onClick={() => void onSetting(`recurring.ignore.${r.key}`, "1").then(onBack)}>
            정기 아님
          </button>
        )}
      </div>
    </div>
  );
}
