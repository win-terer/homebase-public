import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { amountView, flowOf, ledgerApi, pairCancels, withSavedMemo, won, type CategoryOption, type Transaction } from "./api.ts";
import { CategoryPicker, type CategoryChoice } from "./CategoryPicker.tsx";
import { MemoEditor, useMemoUses } from "./MemoEditor.tsx";
import { useCategoryOffer } from "./SameOffer.tsx";
import type { MemoUse } from "./memo-suggest.ts";
import { formatDay } from "./dates.ts";
import { mergeSplits, splitSummary } from "./split-pay.ts";
import { suggestSearch, type SearchTerms } from "./search-suggest.ts";
import { countedRows } from "./day-view.ts";
import { defaultUnit, periodSums, type SumUnit } from "./search-total.ts";

/** 가맹점 이름·메모·상세 메모·금액 검색. 결과를 누르면 달력의 그날로 간다 */
export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get("q")?.trim() ?? "";
  const [result, setResult] = useState<{ q: string; results: Transaction[]; more: boolean; cancels: Transaction[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  useEffect(() => {
    ledgerApi.categories().then(setCategories, () => {});
  }, []);

  const { memoUses, addMemoUse, refreshMemoUses } = useMemoUses(Boolean(q));
  const [reload, setReload] = useState(0);

  /**
   * 갈려 들어온 결제는 한 줄로 (split-pay.ts). **검색에 걸린 줄들 안에서만** 묶는다 — 포인트
   * 줄에는 메모가 없어 `#몽이` 같은 검색에는 아예 안 걸리고, 그걸 찾아오자고 조회를 하나 더
   * 늘리지는 않는다. 가게 이름으로 찾으면 두 줄이 다 걸려 묶인다.
   *
   * 취소된 결제에는 취소선. 짝이 되는 환불 줄은 메모가 없어 검색에 안 걸리므로 서버가 `cancels`
   * 로 따로 보내 준다 — 그 줄은 **목록에 그리지 않고** 짝 맞추는 데만 쓴다 (2026-11-12 사용자 요청).
   */
  const rows = useMemo(() => mergeSplits(result?.results ?? []), [result]);
  const cancels = useMemo(() => pairCancels([...rows, ...mergeSplits(result?.cancels ?? [])]), [rows, result]);
  /** 합계에 넣을 줄 — 취소된 결제와 그 환불은 **둘 다** 뺀다 (day-view.ts 와 같은 잣대) */
  const counted = useMemo(() => countedRows(rows, cancels), [rows, cancels]);

  /** 결과에서 바로 메모 고치기 (달력으로 가지 않고) */
  async function saveMemo(id: number, change: { memo?: string | null; note?: string | null }) {
    const saved = await ledgerApi.setMemo(id, change);
    const tx = result?.results.find((t) => t.id === id);
    setResult((r) => r && { ...r, results: r.results.map((t) => (t.id === id ? withSavedMemo(t, saved) : t)) });
    if (tx && saved.memo && change.memo !== undefined) addMemoUse(tx, saved.memo);
  }

  /** 결과에서 바로 카테고리 바꾸기 (미분류를 하나씩 정리할 때). 줄은 그대로 두고 표시만 바꾼다 */
  async function changeCategory(id: number, choice: CategoryChoice): Promise<{ categoryId: number | null; label: string | null }> {
    const created = choice !== null && "newPath" in choice;
    const saved = await ledgerApi.setCategory(id, created ? { newCategory: choice.newPath } : { categoryId: choice?.id ?? null });
    const list = created ? await ledgerApi.categories() : categories;
    if (created) setCategories(list);
    const cat = list.find((c) => c.id === saved.categoryId);
    const parent = cat?.parentId ? list.find((c) => c.id === cat.parentId) : undefined;
    setResult((r) =>
      r && {
        ...r,
        results: r.results.map((t) =>
          t.id === id ? { ...t, categoryId: saved.categoryId, category: cat?.name ?? null, categoryGroup: parent?.name ?? cat?.name ?? null } : t,
        ),
      },
    );
    return { categoryId: saved.categoryId, label: cat ? cat.label.replace(" > ", " › ") : null };
  }

  useEffect(() => {
    setError(null);
    if (!q) return setResult(null);
    void reload;
    let alive = true;
    ledgerApi.search(q).then(
      (r) => alive && setResult({ q, ...r }),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [q, reload]);

  const loading = q && result?.q !== q && !error;
  const onMemosApplied = () => {
    setReload((n) => n + 1);
    void refreshMemoUses();
  };

  return (
    <section className="lg-page sr-page">
      <div className="lg-toolbar">
        <h1>검색</h1>
      </div>
      <SearchBox initial={q} autoFocus className="sr-box" />
      {error && <p className="hb-error">{error}</p>}
      {!q && (
        <p className="hb-muted">
          가게 이름, 메모, 상세 메모에 적은 품목, 카테고리 이름, 금액(예: 8900)으로 찾을 수 있어요. <strong>미분류</strong>를 검색하면 카테고리 없는 결제를 모아서 바로 분류할 수 있어요.
        </p>
      )}
      {loading && <p className="hb-muted">찾는 중…</p>}
      {result && result.q === q && (
        <>
          {rows.length === 0 ? <p className="sr-count">찾은 기록이 없어요.</p> : <Totals key={q} rows={counted} shown={rows.length} more={result.more} />}
          {rows.length > 0 && (
            <ul className="sr-list">
              {rows.map((tx) => (
                <ResultRow
                  key={tx.id}
                  tx={tx}
                  cancel={cancels.cancelled.has(tx.id) ? "original" : cancels.absorbed.has(tx.id) ? "refund" : null}
                  q={q}
                  categories={categories}
                  onChangeCategory={changeCategory}
                  memoUses={memoUses}
                  onSaveMemo={saveMemo}
                  onMemosApplied={onMemosApplied}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/**
 * 결과 합계 — 나간 돈·들어온 돈과 **기간별(달별·해별)** 합계 (2026-11-18 사용자 요청).
 *
 * 받아 온 줄로만 센다 (`search-total.ts` 참고 — 합계 쿼리를 따로 보내면 전체 훑기가 한 번 더 돈다).
 * 200건에서 잘린 검색은 그만큼만 더한 값이라 그렇게 적어 둔다.
 */
const PERIODS_KEY = "hb.srPeriods";
const readOpen = () => {
  try {
    return localStorage.getItem(PERIODS_KEY) !== "off";
  } catch {
    return true;
  }
};

function Totals({ rows, shown, more }: { rows: Transaction[]; shown: number; more: boolean }) {
  // 검색어가 바뀌면 다시 고르게 key={q} 로 새로 만든다
  const [unit, setUnit] = useState<SumUnit>(() => defaultUnit(rows));
  const [open, setOpen] = useState(readOpen);
  const flow = useMemo(() => flowOf(rows), [rows]);
  const sums = useMemo(() => periodSums(rows, unit), [rows, unit]);
  const outRows = rows.filter((t) => t.amount < 0).length;
  const max = Math.max(1, ...sums.map((s) => Math.max(s.out, s.in)));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(PERIODS_KEY, next ? "on" : "off");
    } catch {
      // 저장이 막힌 브라우저에서도 이번 방문 동안은 동작한다
    }
  };
  return (
    <div className="sr-totals">
      <div className="sr-sum">
        <span className="sr-count">
          {shown}건{more ? " (최근 것부터 200건만)" : ""}
        </span>
        {flow.out > 0 && (
          <span className="sr-sum-item">
            나간 돈 <b className="hb-secret">{won(flow.out)}</b>
          </span>
        )}
        {flow.in > 0 && (
          <span className="sr-sum-item tone-in">
            들어온 돈 <b className="hb-secret">{won(flow.in)}</b>
          </span>
        )}
        {flow.out > 0 && outRows > 1 && <span className="sr-sum-avg">한 번에 평균 {won(Math.round(flow.out / outRows))}</span>}
        {sums.length > 1 && (
          <button type="button" className="sr-sum-toggle" onClick={toggle} aria-expanded={open}>
            기간별 {open ? "▴" : "▾"}
          </button>
        )}
      </div>
      {open && sums.length > 1 && (
        <div className="sr-periods">
          <div className="sr-period-units" role="group" aria-label="합계 단위">
            {(["month", "year"] as const).map((u) => (
              <button key={u} type="button" className={unit === u ? "is-on" : ""} aria-pressed={unit === u} onClick={() => setUnit(u)}>
                {u === "month" ? "달별" : "해별"}
              </button>
            ))}
          </div>
          <ul>
            {sums.map((s) => (
              <li key={s.key}>
                <span className="sr-period-label">{s.label}</span>
                <span className="sr-period-count">{s.count}건</span>
                <span className="sr-period-bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, (s.out / max) * 100)}%` }} />
                </span>
                <span className="sr-period-amount hb-secret">
                  {s.out > 0 ? won(s.out) : "—"}
                  {s.in > 0 && <em>+{won(s.in)}</em>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 탭 줄과 검색 화면이 같이 쓰는 입력칸. Enter 로 찾는다 (입력할 때마다 찾으면 D1 읽기가 쌓인다) */
/** 자동완성 목록: 처음 입력칸을 누를 때 한 번 받아 10분 동안 모든 검색칸이 같이 쓴다 */
let termsCache: { at: number; terms: Promise<SearchTerms> } | null = null;
function loadTerms(): Promise<SearchTerms> {
  if (!termsCache || Date.now() - termsCache.at > 10 * 60_000) {
    const terms = Promise.all([ledgerApi.searchTerms(), ledgerApi.categories()]).then(([t, cats]) => ({
      ...t,
      categories: [...new Set(cats.map((c) => c.name))],
    }));
    terms.catch(() => (termsCache = null));
    termsCache = { at: Date.now(), terms };
  }
  return termsCache.terms;
}

export function SearchBox({ initial = "", autoFocus = false, className = "" }: { initial?: string; autoFocus?: boolean; className?: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState(initial);
  const [terms, setTerms] = useState<SearchTerms | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  useEffect(() => setValue(initial), [initial]);
  const suggestions = useMemo(() => (terms && open ? suggestSearch(terms, value) : []), [terms, open, value]);
  const go = (q: string) => {
    const query = q.trim();
    setOpen(false);
    setActive(-1);
    if (query) navigate(`/ledger/search?q=${encodeURIComponent(query)}`);
  };
  return (
    <form
      role="search"
      className={`lg-search ${className}`}
      onSubmit={(e) => {
        e.preventDefault();
        go(value);
      }}
    >
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        maxLength={50}
        placeholder="검색 (가게·메모·카테고리)"
        aria-label="기록 검색"
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-autocomplete="list"
        autoComplete="off"
        onFocus={() => {
          loadTerms().then(setTerms, () => {});
        }}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter·화살표는 무시
          if (e.key === "ArrowDown" && suggestions.length) {
            e.preventDefault();
            setActive((i) => Math.min(suggestions.length - 1, i + 1));
          } else if (e.key === "ArrowUp" && suggestions.length) {
            e.preventDefault();
            setActive((i) => Math.max(-1, i - 1));
          } else if (e.key === "Enter" && active >= 0 && suggestions[active]) {
            e.preventDefault();
            setValue(suggestions[active]!.query);
            go(suggestions[active]!.query);
          } else if (e.key === "Escape") {
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      {suggestions.length > 0 && (
        <ul className="lg-memo-suggest lg-search-suggest" role="listbox">
          {suggestions.map((s, i) => (
            <li key={`${s.kind}-${s.text}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={i === active ? "is-active" : ""}
                // 입력칸 blur 보다 먼저 고르게
                onMouseDown={(e) => {
                  e.preventDefault();
                  setValue(s.query);
                  go(s.query);
                }}
              >
                <span className="lg-search-suggest-text">{s.text}</span>
                <span className="lg-search-suggest-kind">{s.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function ResultRow({
  tx,
  cancel = null,
  q,
  categories,
  onChangeCategory,
  memoUses,
  onSaveMemo,
  onMemosApplied,
}: {
  tx: Transaction;
  q: string;
  categories: CategoryOption[];
  onChangeCategory(id: number, choice: CategoryChoice): Promise<{ categoryId: number | null; label: string | null }>;
  memoUses: MemoUse[];
  onSaveMemo(id: number, change: { memo?: string | null; note?: string | null }): Promise<void>;
  onMemosApplied(): void;
  /** 취소된 결제('original')인지, 그 환불 줄('refund')인지 */
  cancel?: "original" | "refund" | null;
}) {
  const amount = amountView(tx);
  const categoryOffer = useCategoryOffer(tx, onMemosApplied);
  return (
    <li className={`sr-row${cancel ? ` is-${cancel === "original" ? "cancelled" : "cancel-refund"}` : ""}`}>
      <Link className="sr-date" to={`/ledger?month=${tx.date.slice(0, 7)}&date=${tx.date}`} title="달력에서 보기">
        <span>
          {formatDay(tx.date)}
          {tx.time && <span className="sr-time">{tx.time.slice(0, 5)}</span>}
        </span>
        <span className="sr-year">{tx.date.slice(0, 4)}</span>
      </Link>
      <span className="sr-main">
        <Link className="sr-title" to={`/ledger?month=${tx.date.slice(0, 7)}&date=${tx.date}`}>
          {mark(tx.merchant, q)}
        </Link>
        <span className="sr-meta">
          {/* 이체는 통계에 안 들어가서 카테고리를 두지 않는다 */}
          {tx.kind !== "transfer" && (
            <CategoryPicker
              compact
              kind={tx.kind}
              categories={categories}
              value={tx.categoryId ? { id: tx.categoryId } : null}
              onChange={(choice) => void onChangeCategory(tx.id, choice).then(categoryOffer.after)}
            />
          )}
          {tx.tags?.map((t) => (
            <Link key={t} to={`/ledger/search?q=${encodeURIComponent(`#${t}`)}`} className="lg-tag lg-tag-user" title={`'${t}' 태그가 붙은 결제 모아 보기`}>
              #{t}
            </Link>
          ))}
          {tx.splitParts ? <span title="한 번 결제한 것이 여러 줄로 갈려 들어왔어요">{splitSummary(tx.splitParts)}</span> : tx.paymentMethod && <span>{tx.paymentMethod}</span>}
        </span>
        {categoryOffer.node}
      </span>
      <span className={`lg-amount tone-${amount.tone} ${amount.tone === "in" ? "hb-secret" : ""}`}>{amount.text}</span>
      <MemoEditor className="is-inline row-memo" tx={tx} memoUses={memoUses} onSaveMemo={onSaveMemo} onMemosApplied={onMemosApplied} />
    </li>
  );
}

function mark(text: string, q: string): ReactNode {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}
