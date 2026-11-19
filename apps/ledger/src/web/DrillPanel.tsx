import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { amountView, ledgerApi, spendOf, won, type Transaction } from "./api.ts";
import { BarList } from "./charts/BarList.tsx";
import { formatDay } from "./dates.ts";
import { groupSpend, sortTxs } from "./stats.ts";
import { MemoEditor, useMemoUses } from "./MemoEditor.tsx";

export interface Drill {
  title: string;
  /** 제목 아래 작은 글씨 (기간 등) */
  context: string;
  txs: Transaction[];
  /** 묶음별 막대 (예: 카테고리면 소분류, '기타'면 카테고리). 막대를 누르면 목록을 그 묶음으로 좁힌다 */
  breakdown?: Breakdown;
}

interface Breakdown {
  title: string;
  key(t: Transaction): string;
  /** 묶음 하나를 고르면 그 안을 다시 나눠 보여줄 기준 (예: 카테고리 → 소분류) */
  next?: Breakdown;
}

/** 통계에서 누른 항목의 거래 목록. PC 는 오른쪽 패널, 모바일은 아래에서 올라오는 시트. 보기만 한다 */
export function DrillPanel({ drill, onClose, onChanged }: { drill: Drill; onClose(): void; /** 메모를 고친 뒤 (통계 기록 다시 읽기) */ onChanged(): void }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<"recent" | "amount">("recent");
  // 여기서 고친 메모 (드릴 목록은 열 때 받은 기록이라 고친 것만 덮어 보여준다)
  const [edited, setEdited] = useState<Map<number, { memo: string | null; note: string | null }>>(new Map());
  const { memoUses, addMemoUse, refreshMemoUses } = useMemoUses();
  async function saveMemo(id: number, change: { memo?: string | null; note?: string | null }) {
    const saved = await ledgerApi.setMemo(id, change);
    setEdited((m) => new Map(m).set(id, saved));
    const tx = drill.txs.find((t) => t.id === id);
    if (tx && saved.memo && change.memo !== undefined) addMemoUse(tx, saved.memo);
    onChanged();
  }
  const [appliedNote, setAppliedNote] = useState(false);
  // 고른 묶음들 (단계별): [카테고리, 소분류]
  const [path, setPath] = useState<string[]>([]);

  useEffect(() => {
    setPath([]);
    setSort("recent");
  }, [drill]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 단계마다: 그 단계의 기준, 그 단계까지 좁힌 거래, 그 거래를 나눈 막대
  const levels = useMemo(() => {
    const out: { breakdown: Breakdown; txs: Transaction[]; groups: ReturnType<typeof groupSpend>; parent?: string }[] = [];
    const picks: string[] = [];
    let txs = drill.txs;
    let breakdown = drill.breakdown;
    for (let i = 0; breakdown; i++) {
      const groups = groupSpend(txs, breakdown.key);
      out.push({ breakdown, txs, groups, parent: picks[i - 1] });
      // 묶음이 하나뿐이면 고른 것과 같으니 다음 단계로 바로 내려간다 (예: 한 카테고리만 있는 가게 → 소분류)
      const picked = path[i] ?? (groups.length === 1 ? groups[0]!.label : undefined);
      if (picked === undefined) break;
      picks.push(picked);
      const key = breakdown.key;
      txs = txs.filter((t) => key(t) === picked);
      breakdown = breakdown.next;
    }
    return { out, txs, picks };
  }, [drill, path]);
  const shown = useMemo(() => sortTxs(levels.txs, sort), [levels, sort]);
  // 앞 단계(저절로 내려간 단계 포함)는 그대로 두고 이 단계만 고르거나 풀기
  const pick = (level: number, label: string) =>
    setPath(path[level] === label ? path.slice(0, level) : [...levels.picks.slice(0, level), label]);

  const spend = spendOf(shown);
  const income = shown.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0);
  const count = shown.filter((t) => t.amount < 0 || t.kind === "income").length;

  return (
    <div className="dr-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="dr-panel" role="dialog" aria-modal="true" aria-label={`${drill.title} 상세`}>
        <header className="dr-head">
          <div>
            <h2>
              {drill.title}
              {levels.picks.map((p) => (
                <span key={p} className="dr-part">
                  {" "}
                  › {p}
                </span>
              ))}
            </h2>
            <p className="dr-context">{drill.context}</p>
          </div>
          <button className="lg-icon-button" onClick={onClose} aria-label="닫기" autoFocus>
            ✕
          </button>
        </header>

        <p className="dr-summary">
          {spend !== 0 && (
            <>
              지출 <strong className="hb-secret">{won(spend)}원</strong>
            </>
          )}
          {income > 0 && (
            <>
              {spend !== 0 && " · "}수입 <strong className="flow-in hb-secret">{won(income)}원</strong>
            </>
          )}
          <span className="dr-count"> · {count}건</span>
        </p>

        {levels.out.map(({ breakdown, groups, parent }, level) =>
          // 묶음이 하나뿐이면 막대가 의미 없으니 건너뛴다 (고른 단계는 그대로 둠)
          groups.length > 1 ? (
            <section key={level} className="dr-section">
              <h3>
                {parent ? `${parent} ${breakdown.title}` : breakdown.title}
                {path[level] !== undefined && (
                  <button className="dr-reset" onClick={() => setPath(path.slice(0, level))}>
                    {parent ? `${parent} 전체` : "전체 보기"}
                  </button>
                )}
              </h3>
              <BarList
                ranked={false}
                selected={path[level] ?? null}
                rows={groups.map((g) => ({ label: g.label, ratio: g.share, value: `${won(g.value)}원`, sub: `${g.count}건`, secret: g.label === "수입" }))}
                onSelect={(i) => pick(level, groups[i]!.label)}
              />
            </section>
          ) : null,
        )}

        <section className="dr-section">
          <h3>
            거래 {shown.length}건
            <span className="rv-segment dr-sort" role="radiogroup" aria-label="정렬">
              {(["recent", "amount"] as const).map((v) => (
                <button key={v} role="radio" aria-checked={sort === v} className={sort === v ? "is-active" : ""} onClick={() => setSort(v)}>
                  {v === "recent" ? "최근순" : "금액순"}
                </button>
              ))}
            </span>
          </h3>
          <ul className="dr-list">
            {shown.map((orig) => {
              const t = edited.has(orig.id) ? { ...orig, ...edited.get(orig.id)! } : orig;
              const amount = amountView(t);
              const go = () => navigate(`/ledger?month=${t.date.slice(0, 7)}&date=${t.date}`);
              return (
                <li key={t.id} className="dr-row">
                  <button className="dr-date" onClick={go} title="달력에서 보기">
                    {formatDay(t.date)}
                    {t.time && <span className="dr-time">{t.time.slice(0, 5)}</span>}
                  </button>
                  <span className="dr-main">
                    <button className="dr-merchant" onClick={go} title="달력에서 보기">
                      {t.merchant}
                    </button>
                    <span className="dr-meta">{[t.category && t.category !== t.categoryGroup ? `${t.categoryGroup} › ${t.category}` : t.category, t.paymentMethod].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className={`lg-amount tone-${amount.tone} ${amount.tone === "in" ? "hb-secret" : ""}`}>{amount.text}</span>
                    <MemoEditor
                      className="is-inline row-memo"
                      tx={t}
                      memoUses={memoUses}
                      onSaveMemo={saveMemo}
                      onMemosApplied={() => {
                        setAppliedNote(true);
                        void refreshMemoUses();
                        onChanged();
                      }}
                    />
                </li>
              );
            })}
          </ul>
          {shown.length === 0 && <p className="hb-muted">거래가 없어요.</p>}
          <p className="dr-hint">
            날짜나 가게 이름을 누르면 달력의 그날로 가요.
            {appliedNote && " 다른 결제에 넣은 메모는 패널을 다시 열면 보여요."}
          </p>
        </section>
      </aside>
    </div>
  );
}
