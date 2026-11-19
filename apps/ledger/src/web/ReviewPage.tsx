import { useEffect, useState } from "react";
import { ledgerApi, won, type CategoryOption, type ReviewGroup, type RuleAction } from "./api.ts";
import { CategoryPicker, type CategoryChoice } from "./CategoryPicker.tsx";
import { actionsFor, suggestReview, type ReviewSuggestion } from "./review-suggest.ts";

/** "대분류 > 소분류" 이름을 선택값으로 (없는 이름이면 새로 만들기) */
function choiceFor(path: string | undefined, categories: CategoryOption[]): CategoryChoice {
  if (!path) return null;
  const found = categories.find((c) => c.label === path);
  return found ? { id: found.id } : { newPath: path };
}

const toDecision = (choice: CategoryChoice) =>
  choice && "newPath" in choice ? { newCategory: choice.newPath } : { categoryId: choice?.id ?? null };

/** 이름으로 고른 추천. 금액 부호에 맞지 않는 처리(나간 돈을 수입으로 등)면 추천하지 않는다 */
function suggestionFor(g: ReviewGroup): ReviewSuggestion | null {
  const s = suggestReview(g.counterparty, g.total);
  return s && actionsFor(g.rows.map((r) => r.amount)).some((a) => a.value === s.action) ? s : null;
}

export function ReviewPage() {
  const [groups, setGroups] = useState<ReviewGroup[] | null>(null);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    ledgerApi.review().then(setGroups, (e: Error) => setError(e.message));
    ledgerApi.categories().then(setCategories, () => {});
  }, []);

  const suggested = (groups ?? []).flatMap((g) => {
    const s = suggestionFor(g);
    return s ? [{ group: g, suggestion: s }] : [];
  });
  const [bulk, setBulk] = useState(false);

  /** 추천이 있는 상대방을 한 번에 처리 (한 건씩 차례로 저장) */
  async function applySuggested() {
    if (!window.confirm(`추천대로 ${suggested.length}곳을 처리할까요? 처리한 뒤에도 다음 가져오기부터 같은 규칙이 적용돼요.`)) return;
    setBulk(true);
    let list = categories;
    let done = 0;
    try {
      for (const { group, suggestion } of suggested) {
        const needsCategory = suggestion.action === "expense" || suggestion.action === "income";
        await ledgerApi.decide({ counterparty: group.counterparty, action: suggestion.action, ...(needsCategory ? toDecision(choiceFor(suggestion.category, list)) : {}) });
        setGroups((all) => all?.filter((g) => g.counterparty !== group.counterparty) ?? null);
        done++;
        if (needsCategory && !list.some((c) => c.label === suggestion.category)) list = await ledgerApi.categories();
      }
      setDone(`추천대로 ${done}곳을 처리했어요. 남은 건 직접 골라주세요.`);
    } catch (e) {
      setError(`${done}곳 처리 후 멈췄어요: ${(e as Error).message}`);
    } finally {
      setCategories(await ledgerApi.categories().catch(() => list));
      setBulk(false);
    }
  }

  async function decide(group: ReviewGroup, action: RuleAction, label: string, category: { categoryId?: number | null; newCategory?: string }) {
    const result = await ledgerApi.decide({ counterparty: group.counterparty, action, ...category });
    setGroups((list) => list?.filter((g) => g.counterparty !== group.counterparty) ?? null);
    setDone(`${group.counterparty} ${result.affected}건 → ${label}. 다음 가져오기부터 자동으로 적용돼요.`);
    if (category.newCategory) ledgerApi.categories().then(setCategories, () => {});
  }

  return (
    <section className="lg-page">
      <h1>확인 필요한 이체</h1>
      <p className="hb-muted">
        뱅크샐러드 분류만으로는 판단이 어려운 이체예요. 상대방별로 한 번만 정하면 지금 있는 건에 바로 적용되고, 다음
        가져오기부터 자동으로 처리돼요.
      </p>
      {error && <p className="hb-error">{error}</p>}
      {done && <p className="rv-done">{done}</p>}
      {suggested.length > 0 && (
        <div className="rv-suggest-bar">
          <span>
            이름으로 알 수 있는 <strong>{suggested.length}곳</strong>은 처리 방법을 미리 골라뒀어요. <span className="rv-badge">추천</span> 표시를 확인하고 한 번에 적용하거나, 줄마다 바꿔서 적용하세요.
          </span>
          <button className="hb-button" disabled={bulk} onClick={() => void applySuggested()}>
            {bulk ? "처리 중…" : `추천 ${suggested.length}곳 한 번에 적용`}
          </button>
        </div>
      )}
      {groups?.length === 0 && <p className="hb-card">확인할 이체가 없어요.</p>}
      {groups && groups.length > 0 && (
        <div className="rv-card">
        <table className="rv-table">
          <thead>
            <tr>
              <th>상대방</th>
              <th className="num">건수</th>
              <th>기간</th>
              <th className="num">합계</th>
              <th>처리</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <GroupRow key={g.counterparty} group={g} categories={categories} onDecide={decide} />
            ))}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}

function GroupRow({
  group: g,
  categories,
  onDecide,
}: {
  group: ReviewGroup;
  categories: CategoryOption[];
  onDecide(g: ReviewGroup, action: RuleAction, label: string, category: { categoryId?: number | null; newCategory?: string }): Promise<void>;
}) {
  const actions = actionsFor(g.rows.map((r) => r.amount));
  const suggestion = suggestionFor(g);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<RuleAction | null>(suggestion?.action ?? null);
  // 사용자가 고르기 전에는 추천 카테고리 (목록이 늦게 와도 맞춰지도록 매번 계산)
  const [picked, setPicked] = useState<CategoryChoice | undefined>(undefined);
  const category = picked !== undefined ? picked : choiceFor(suggestion?.category, categories);
  const setCategory = (c: CategoryChoice) => setPicked(c);
  const [saving, setSaving] = useState(false);
  const needsCategory = action === "expense" || action === "income";

  async function apply() {
    if (!action) return;
    setSaving(true);
    try {
      await onDecide(
        g,
        action,
        actions.find((a) => a.value === action)?.label ?? action,
        !needsCategory
          ? {}
          : category && "newPath" in category
            ? { newCategory: category.newPath }
            : { categoryId: category?.id ?? null },
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <tr className="rv-row">
        <td>
          <button className="rv-name" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "▾" : "▸"} {g.counterparty}
          </button>
          {suggestion && (
            <span className="rv-badge" title={`이름으로 추천: ${suggestion.reason}`}>
              추천 · {suggestion.reason}
            </span>
          )}
          {g.names.length > 1 && (
            <div className="rv-names" title={g.names.join(", ")}>
              {g.names.length > 3 ? `${g.names.slice(0, 2).join(", ")} 외 ${g.names.length - 2}개` : g.names.join(", ")}
            </div>
          )}
        </td>
        <td className="num">{g.count}건</td>
        <td className="rv-period">{g.from === g.to ? g.from : `${g.from} ~ ${g.to}`}</td>
        <td className={`num ${g.total >= 0 ? "flow-in hb-secret" : "flow-out"}`}>
          {g.total >= 0 ? "+" : "-"}
          {won(Math.abs(g.total))}
        </td>
        <td>
          <div className="rv-actions">
            <div className="rv-segment" role="radiogroup" aria-label={`${g.counterparty} 처리`}>
              {actions.map((a) => (
                <button
                  key={a.value}
                  role="radio"
                  aria-checked={action === a.value}
                  className={action === a.value ? "is-active" : ""}
                  title={a.hint}
                  onClick={() => {
                    // 처리를 바꾸면 고른 카테고리도 비운다 (수입 ↔ 지출 카테고리가 섞이지 않게). 추천 처리로 돌아오면 추천 카테고리
                    if (a.value !== action) setPicked(a.value === suggestion?.action ? undefined : null);
                    setAction(a.value);
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
            {/* 환불도 지출 카테고리에서 빼는 것이라 지출 카테고리를 보여준다 */}
            {needsCategory && <CategoryPicker categories={categories} value={category} onChange={setCategory} kind={action === "income" ? "income" : "expense"} />}
            <button
              className="hb-button rv-apply"
              disabled={!action || saving}
              onClick={() => void apply()}
            >
              적용
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr className="rv-detail">
          <td colSpan={5}>
            <table>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.date}</td>
                    <td>{r.time?.slice(0, 5) ?? "–"}</td>
                    <td>{r.merchant}</td>
                    <td className="hb-muted">{r.paymentMethod}</td>
                    <td className={`num ${r.amount >= 0 ? "flow-in hb-secret" : "flow-out"}`}>
                      {r.amount >= 0 ? "+" : "-"}
                      {won(Math.abs(r.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
