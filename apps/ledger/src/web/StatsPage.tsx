import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { compactWon, ledgerApi, pairCancels, shortWon, won, type Transaction } from "./api.ts";
import { countedRows } from "./day-view.ts";
import { mergeSplits } from "./split-pay.ts";
import { BarList } from "./charts/BarList.tsx";
import { ColumnChart } from "./charts/ColumnChart.tsx";
import { DonutChart } from "./charts/DonutChart.tsx";
import { DrillPanel, type Drill } from "./DrillPanel.tsx";
import { Heatmap } from "./charts/Heatmap.tsx";
import { today } from "./dates.ts";
import {
  byCategory,
  byTag,
  currentAt,
  expensesAt,
  expensesInGroup,
  expensesOutside,
  hasFullCoverage,
  makePeriod,
  recentPeriods,
  shortLabel,
  spendByPeriod,
  summarize,
  TIME_SLOTS,
  topMerchants,
  topMerchantsByAmount,
  trend,
  txsInBucket,
  txsInCell,
  WEEKDAY_LABELS_MON,
  weekdayTimeGrid,
  type PeriodKind,
  type Summary,
} from "./stats.ts";

const KINDS: { value: PeriodKind; label: string; prev: string; compare: number; compareTitle: string }[] = [
  { value: "week", label: "주간", prev: "지난주", compare: 8, compareTitle: "최근 8주 지출" },
  { value: "month", label: "월간", prev: "지난달", compare: 6, compareTitle: "최근 6개월 지출" },
  { value: "year", label: "연간", prev: "작년", compare: 3, compareTitle: "연도별 지출" },
];

/** 카테고리 도넛 색: dataviz 검증을 통과한 범주 색 순서 (5개 + 기타 회색) */
const CATEGORY_COLORS = ["var(--st-cat-1)", "var(--st-cat-2)", "var(--st-cat-3)", "var(--st-cat-4)", "var(--st-cat-5)"];

export function StatsPage() {
  const [params, setParams] = useSearchParams();
  const todayDate = today();
  const kind = (KINDS.find((k) => k.value === params.get("period"))?.value ?? "month") as PeriodKind;
  const period = useMemo(() => makePeriod(kind, params.get("at") ?? currentAt(kind, todayDate)), [kind, params, todayDate]);
  const prevPeriod = useMemo(() => makePeriod(kind, period.prevAt), [kind, period.prevAt]);
  const kindInfo = KINDS.find((k) => k.value === kind)!;
  const compared = useMemo(() => recentPeriods(kind, period.at, kindInfo.compare), [kind, period.at, kindInfo.compare]);
  const [compareTxs, setCompareTxs] = useState<Transaction[]>([]);

  const [txs, setTxs] = useState<Transaction[] | null>(null);
  // 상세 패널에서 메모를 고치면 조용히 다시 읽는다 (화면은 그대로)
  const [reload, setReload] = useState(0);
  const [prevTxs, setPrevTxs] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTxs(null);
    ledgerApi.transactions(period.from, period.to).then(setTxs, (e: Error) => setError(e.message));
    ledgerApi.transactions(prevPeriod.from, prevPeriod.to).then(setPrevTxs, () => setPrevTxs([]));
    ledgerApi.transactions(compared[0]!.from, period.to).then(setCompareTxs, () => setCompareTxs([]));
  }, [period.from, period.to, prevPeriod.from, prevPeriod.to, compared]);
  useEffect(() => {
    if (reload) ledgerApi.transactions(period.from, period.to).then(setTxs, () => {});
  }, [reload]);

  const go = (next: { period?: PeriodKind; at?: string }) => {
    const p = new URLSearchParams(params);
    if (next.period) {
      p.set("period", next.period);
      p.delete("at");
    }
    if (next.at) p.set("at", next.at);
    setParams(p, { replace: true });
  };

  const navigate = useNavigate();
  const all = txs ?? [];
  /**
   * **취소된 결제는 짝을 둘 다 뺀다** (2026-11-12 사용자 지적). 환불 줄이 금액을 음수로
   * 상쇄하니 합계는 맞아떨어지는 것 같지만, 실제로는 세 군데가 어긋난다:
   *   ① 건수 — 취소한 결제가 '결제 1건'으로 남는다 (환불 줄은 안 세므로 상쇄가 없다)
   *   ② 분류 — 환불 줄의 분류가 원래 결제와 다를 수 있다. 실제로 쿠팡 식비 결제를 취소했는데
   *      환불 줄은 가게 이름 규칙 때문에 쇼핑으로 들어와, 식비는 안 줄고 쇼핑만 음수가 됐다
   *   ③ 태그 — 환불 줄에는 메모가 없어 태그도 안 붙는다. 상쇄할 줄이 아예 없다
   * 날짜 상세의 하루 합계가 쓰는 `countedRows` 와 같은 규칙이다.
   */
  /**
   * 갈려 들어온 결제(네이버페이 포인트 + 카드)는 **한 줄로 묶은 뒤** 센다 — 안 그러면 한 번 산
   * 것이 `결제 건수` 2건, `자주 간 곳` 2번으로 잡힌다. 합계는 어느 쪽이든 같다 (split-pay.ts).
   */
  const list = useMemo(() => withSplits(all), [all]);
  const prevList = useMemo(() => withSplits(prevTxs), [prevTxs]);
  const compareList = useMemo(() => withSplits(compareTxs), [compareTxs]);
  const summary = summarize(list, period, todayDate);
  const prevSummary = hasFullCoverage(prevList, prevPeriod) ? summarize(prevList, prevPeriod, todayDate) : null;
  const buckets = trend(list, period);
  const categories = byCategory(list, 5);
  const compareTotals = spendByPeriod(compareList, compared);
  const tags = byTag(list);
  const merchants = topMerchants(list);
  const bigSpenders = topMerchantsByAmount(list);
  const grid = weekdayTimeGrid(list);
  const prevLabel = kindInfo.prev;

  // 눌러서 보는 상세 (기간이 바뀌면 닫는다)
  const [drill, setDrill] = useState<Drill | null>(null);
  const closeDrill = useCallback(() => setDrill(null), []);
  useEffect(() => setDrill(null), [period.from, period.to]);
  const subKey = (t: Transaction) => (t.category && t.category !== t.categoryGroup ? t.category : "소분류 없음");
  // 카테고리별 막대에서 하나를 고르면 그 카테고리의 소분류별 막대가 이어서 나온다
  const byGroup = { title: "카테고리별", key: (t: Transaction) => t.categoryGroup ?? "미분류", next: { title: "소분류별", key: subKey } };
  const openCategory = (i: number) => {
    const c = categories[i]!;
    const others = c.label === "기타" && categories.length > 1;
    setDrill({
      title: c.label === "기타" ? "기타 카테고리" : c.label,
      context: period.label,
      txs: others ? expensesOutside(list, categories.filter((x) => x.label !== "기타").map((x) => x.label)) : expensesInGroup(list, c.label),
      breakdown: others ? byGroup : { title: "소분류별", key: subKey },
    });
  };
  const openMerchant = (label: string) =>
    setDrill({ title: label, context: period.label, txs: expensesAt(list, label), breakdown: byGroup });
  const isCurrent = period.from <= todayDate && todayDate <= period.to;

  return (
    <section className="lg-page st-page">
      <div className="lg-toolbar">
        <div className="lg-month-nav">
          <div className="rv-segment" role="radiogroup" aria-label="기간 단위">
            {KINDS.map((k) => (
              <button key={k.value} role="radio" aria-checked={kind === k.value} className={kind === k.value ? "is-active" : ""} onClick={() => go({ period: k.value })}>
                {k.label}
              </button>
            ))}
          </div>
          <h1 className="st-title">{period.label}</h1>
          <div className="lg-nav-group">
            <button className="lg-icon-button" onClick={() => go({ at: period.prevAt })} aria-label="이전 기간">
              ‹
            </button>
            <button className="lg-text-button" disabled={isCurrent} onClick={() => go({ at: currentAt(kind, todayDate) })}>
              {kind === "week" ? "이번 주" : kind === "month" ? "이번 달" : "올해"}
            </button>
            <button className="lg-icon-button" onClick={() => go({ at: period.nextAt })} aria-label="다음 기간">
              ›
            </button>
          </div>
        </div>
      </div>

      {error && <p className="hb-error">{error}</p>}

      <div className={`st-body ${txs === null ? "is-loading" : ""}`}>
        <Kpis summary={summary} prev={prevSummary} prevLabel={prevLabel} />

        <div className="st-card">
          <div className="st-card-head">
            <h2>{kind === "year" ? "월별 지출" : "일별 지출"}</h2>
            <span className="hb-muted">막대에 마우스를 올리면 요약, 누르면 그날 거래가 보여요</span>
          </div>
          <ColumnChart
            data={buckets.map((b) => ({
              key: b.key,
              label: b.label,
              value: b.spend,
              title: b.title,
              lines: [`지출 ${won(Math.max(0, b.spend))}원`, ...(b.income ? [`수입 ${won(b.income)}원`] : [])],
            }))}
            average={
              buckets.length
                ? (() => {
                    const avg = Math.round(buckets.reduce((s, b) => s + Math.max(0, b.spend), 0) / buckets.length);
                    return { value: avg, label: `평균 ${shortWon(avg)}` };
                  })()
                : undefined
            }
            formatTick={(n) => (n === 0 ? "0" : shortWon(n))}
            labelEvery={kind === "month" ? 5 : 0}
            onSelect={(i) => {
              const b = buckets[i]!;
              setDrill({ title: b.title, context: kind === "year" ? "월별 지출" : "일별 지출", txs: txsInBucket(list, period, b.key), breakdown: { ...byGroup, key: (t) => (t.kind === "income" ? "수입" : (t.categoryGroup ?? "미분류")) } });
            }}
          />
        </div>

        <div className="st-columns">
          <div className="st-card">
            <div className="st-card-head">
              <h2>카테고리별 지출</h2>
              <span className="hb-muted">상위 5개 + 기타 · 누르면 거래 목록</span>
            </div>
            <DonutChart
              centerLabel="총 지출"
              formatValue={(n) => `${won(n)}원`}
              slices={categories.map((c, i) => ({
                label: c.label,
                value: c.value,
                color: c.label === "기타" ? "var(--st-cat-other)" : CATEGORY_COLORS[i]!,
                sub: `${c.count}건`,
              }))}
              onSelect={openCategory}
            />
          </div>
          <div className="st-card">
            <div className="st-card-head">
              <h2>{kindInfo.compareTitle}</h2>
              <span className="hb-muted">지금 보는 기간 강조 · 누르면 그 기간으로</span>
            </div>
            <ColumnChart
              height={300}
              ariaLabel={kindInfo.compareTitle}
              highlightKey={period.from}
              formatTick={(n) => (n === 0 ? "0" : shortWon(n))}
              data={compared.map((p, i) => ({
                key: p.from,
                label: shortLabel(p),
                value: compareTotals[i] ?? 0,
                title: p.label,
                lines: [`지출 ${won(Math.max(0, compareTotals[i] ?? 0))}원`],
              }))}
              onSelect={(i) => go({ at: compared[i]!.at })}
            />
          </div>
        </div>

        <div className="st-columns">
          <div className="st-card">
            <div className="st-card-head">
              <h2>자주 간 곳</h2>
              <span className="hb-muted">결제 횟수 순 · 누르면 거래 목록</span>
            </div>
            <BarList
              rows={merchants.map((m) => ({
                label: m.label,
                ratio: m.share,
                value: `${m.count}회`,
                sub: `${won(m.value)}원`,
              }))}
              onSelect={(i) => openMerchant(merchants[i]!.label)}
            />
          </div>
          <div className="st-card">
            <div className="st-card-head">
              <h2>많이 쓴 곳</h2>
              <span className="hb-muted">금액 순 (환불 반영) · 누르면 거래 목록</span>
            </div>
            <BarList
              rows={bigSpenders.map((m) => ({
                label: m.label,
                ratio: m.share,
                value: `${won(m.value)}원`,
                sub: `${m.count}회`,
              }))}
              onSelect={(i) => openMerchant(bigSpenders[i]!.label)}
            />
          </div>
        </div>

        {/* 태그는 쓰는 사람만 쓰므로 붙은 게 있을 때만 보여 준다 */}
        {tags.length > 0 && (
          <div className="st-card">
            <div className="st-card-head">
              <h2>태그</h2>
              <span className="hb-muted">메모 낱말로 붙은 태그 · 한 결제가 여러 태그에 들어갈 수 있어 합계와는 다름 · 누르면 모아 보기</span>
            </div>
            <BarList
              rows={tags.map((t) => ({ label: `#${t.label}`, ratio: t.share, value: `${won(t.value)}원`, sub: `${t.count}회` }))}
              onSelect={(i) => navigate(`/ledger/search?q=${encodeURIComponent(`#${tags[i]!.label}`)}`)}
            />
          </div>
        )}

        <div className="st-card">
          <div className="st-card-head">
            <h2>요일·시간대 패턴</h2>
            <span className="hb-muted">칸 숫자는 결제 횟수 (1회 평균 금액) · 자동결제(주거·보험·통신/구독·세금)와 시간 없는 기록은 뺌</span>
          </div>
          <Heatmap
            rows={WEEKDAY_LABELS_MON}
            cols={TIME_SLOTS}
            values={grid}
            format={(cell, r, c) =>
              `${r}요일 ${c} · ${cell.count}회 · ${won(cell.spend)}원${cell.count ? ` · 1회 평균 ${won(Math.round(cell.spend / cell.count))}원` : ""}`
            }
            onSelect={(r, c) =>
              setDrill({
                title: `${WEEKDAY_LABELS_MON[r]}요일 ${TIME_SLOTS[c]}`,
                context: `${period.label} · 자동결제 제외`,
                txs: txsInCell(list, r, c),
                breakdown: byGroup,
              })
            }
            label={(cell) => ({ main: `${cell.count}건`, sub: `(${compactWon(Math.round(cell.spend / cell.count))})` })}
          />
        </div>

        <p className="st-note">
          이체(보낸 돈·받은 돈)는 통계에 넣지 않아요. 확인 필요한 이체를 정리하면 지출·수입에 반영돼요.
        </p>
      </div>
      {drill && <DrillPanel drill={drill} onClose={closeDrill} onChanged={() => setReload((n) => n + 1)} />}
    </section>
  );
}

function Kpis({ summary: s, prev, prevLabel }: { summary: Summary; prev: Summary | null; prevLabel: string }) {
  const delta = (now: number, before: number | undefined) => {
    if (!before) return null;
    const pct = Math.round(((now - before) / before) * 100);
    return `${prevLabel} 대비 ${pct > 0 ? "▲" : pct < 0 ? "▼" : ""}${Math.abs(pct)}%`;
  };
  const tiles = [
    { label: "지출", value: `${won(s.spend)}원`, sub: prev ? delta(s.spend, prev.spend) : `${prevLabel} 기록이 부족해 비교 안 함` },
    { label: "수입", value: `${won(s.income)}원`, sub: s.smallIncome.count ? `소액 수입 ${s.smallIncome.count}건 +${won(s.smallIncome.total)}원 포함` : delta(s.income, prev?.income), tone: "flow-in" },
    { label: "수입 - 지출", value: `${s.net >= 0 ? "+" : "-"}${won(Math.abs(s.net))}원`, sub: null, tone: s.net >= 0 ? "flow-in" : "flow-out" },
    { label: "하루 평균 지출", value: `${won(s.dailyAvg)}원`, sub: delta(s.dailyAvg, prev?.dailyAvg) },
    { label: "결제 건수", value: `${won(s.count)}건`, sub: delta(s.count, prev?.count) },
  ];
  return (
    <div className="st-kpis">
      {tiles.map((t) => (
        <div key={t.label} className="st-kpi">
          <span className="st-kpi-label">{t.label}</span>
          <strong className={`st-kpi-value hb-secret ${t.tone ?? ""}`}>{t.value}</strong>
          {t.sub && <span className="st-kpi-sub">{t.sub}</span>}
        </div>
      ))}
    </div>
  );
}

/** 쪼개진 결제를 묶고, 취소된 짝을 빼고 — 통계가 세는 줄 */
function withSplits(txs: Transaction[]): Transaction[] {
  const rows = mergeSplits(txs);
  return countedRows(rows, pairCancels(rows));
}
