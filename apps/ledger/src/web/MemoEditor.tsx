import { useEffect, useMemo, useRef, useState } from "react";
import { ledgerApi, won, type Transaction } from "./api.ts";
import { suggestMemos, type MemoUse } from "./memo-suggest.ts";
import { SameOffer } from "./SameOffer.tsx";

/**
 * 거래 한 건의 메모 칸: 한 줄 메모(자동완성) + 상세 메모 + 저장 뒤 "같은 결제에도 넣을까?" 안내.
 * 날짜 상세·검색 결과·통계 상세가 같이 쓴다.
 */
interface Props {
  tx: Transaction;
  memoUses: MemoUse[];
  onSaveMemo(id: number, change: { memo?: string | null; note?: string | null }): Promise<void>;
  /** 같은 결제 여러 건에 메모를 넣은 뒤 (목록 다시 읽기) */
  onMemosApplied(): void;
  className?: string;
}

export function MemoEditor({ tx, memoUses, onSaveMemo, onMemosApplied, className = "" }: Props) {
  const [memo, setMemo] = useState(tx.memo ?? "");
  const [note, setNote] = useState(tx.note ?? "");
  const [noteOpen, setNoteOpen] = useState(Boolean(tx.note));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => setMemo(tx.memo ?? ""), [tx.memo]);
  useEffect(() => {
    setNote(tx.note ?? "");
    if (tx.note) setNoteOpen(true);
  }, [tx.note]);

  async function save(change: { memo?: string | null; note?: string | null }) {
    setState("saving");
    try {
      await onSaveMemo(tx.id, change);
      setState("saved");
      setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch {
      setState("error");
    }
  }

  // 자동완성
  const raw = tx.rawMerchant ?? tx.merchant;
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const suggestions = useMemo(
    () => (focused ? suggestMemos(memoUses, { merchant: raw, amount: tx.amount }, memo) : []),
    [focused, memoUses, raw, tx.amount, memo],
  );

  // 저장 뒤 "같은 결제에도 넣을까?" 안내
  const [offer, setOffer] = useState<{ memo: string; sameAmount: number } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  // 고르기(pick)와 blur 가 같은 값을 두 번 저장하지 않게
  const lastSaved = useRef(tx.memo ?? "");
  useEffect(() => {
    lastSaved.current = tx.memo ?? "";
  }, [tx.memo]);

  async function offerSame(next: string) {
    setApplied(null);
    if (!next) return setOffer(null);
    const similar = await ledgerApi.similarWithoutMemo(raw, tx.amount).catch(() => null);
    // 같은 금액일 때만 묻는다 (금액이 다르면 같은 가게여도 다른 것일 수 있음)
    setOffer(similar && similar.sameAmount > 0 ? { memo: next, sameAmount: similar.sameAmount } : null);
  }

  async function saveMemo(value = memo) {
    const next = value.trim();
    if (next === lastSaved.current) return;
    lastSaved.current = next;
    await save({ memo: next || null });
    await offerSame(next);
  }

  /* 저장 단추: 메모·상세 메모를 한 번에. (칸을 벗어나면 저절로 저장되지만 어디를 눌러야 할지
     알기 어렵다는 사용자 요청 — 2026-11-12) 바뀐 게 없으면 "저장됨"만 보여 준다 */
  const memoDirty = memo.trim() !== lastSaved.current;
  const noteDirty = noteOpen && note.trim() !== (tx.note ?? "");
  const dirty = memoDirty || noteDirty;

  async function saveAll() {
    if (!dirty) {
      setState("saved");
      setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 1500);
      return;
    }
    const next = memo.trim();
    const nextNote = note.trim();
    const change: { memo?: string | null; note?: string | null } = {};
    if (memoDirty) change.memo = next || null;
    if (noteDirty) change.note = nextNote || null;
    if (memoDirty) lastSaved.current = next;
    await save(change);
    if (noteDirty && !nextNote) setNoteOpen(false);
    if (memoDirty) await offerSame(next);
  }

  async function applyOffer(remember: boolean) {
    if (!offer) return;
    const { updated } = await ledgerApi.applyMemo({ merchant: raw, amount: tx.amount, memo: offer.memo, remember });
    setOffer(null);
    setApplied(`${updated}건에 '${offer.memo}' 넣었어요${remember ? ". 앞으로 가져오는 같은 결제에도 넣을게요" : ""}`);
    onMemosApplied();
  }

  function pick(value: string) {
    setMemo(value);
    setActive(-1);
    void saveMemo(value);
  }

  function saveNote() {
    const next = note.trim();
    if (next !== (tx.note ?? "")) void save({ note: next || null });
    if (!next) setNoteOpen(false);
  }

  return (
    <div className={`lg-memo-editor ${className}`}>
        <div className="lg-memo">
          <div className="lg-memo-field">
            <svg className="lg-memo-icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M11.2 2.3a1.5 1.5 0 0 1 2.1 2.1L5.6 12.1 2.5 13l.9-3.1z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
            <input
              value={memo}
              maxLength={200}
              placeholder="메모 추가"
              title="달력에 가게 이름 대신 보여요"
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-autocomplete="list"
              onFocus={() => setFocused(true)}
              onChange={(e) => {
                setMemo(e.target.value);
                setActive(-1);
                setState("idle");
              }}
              onBlur={() => {
                setFocused(false);
                setActive(-1);
                void saveMemo();
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "ArrowDown" && suggestions.length) {
                  e.preventDefault();
                  setActive((i) => Math.min(suggestions.length - 1, i + 1));
                } else if (e.key === "ArrowUp" && suggestions.length) {
                  e.preventDefault();
                  setActive((i) => Math.max(-1, i - 1));
                } else if (e.key === "Enter") {
                  if (active >= 0 && suggestions[active]) {
                    e.preventDefault();
                    pick(suggestions[active]!);
                    setFocused(false);
                  } else e.currentTarget.blur();
                } else if (e.key === "Escape") {
                  setMemo(tx.memo ?? "");
                  setActive(-1);
                }
              }}
            />
            {suggestions.length > 0 && (
              <ul className="lg-memo-suggest" role="listbox">
                {suggestions.map((m, i) => (
                  <li key={m}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      className={i === active ? "is-active" : ""}
                      // 입력칸의 blur 보다 먼저 고르도록
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(m);
                      }}
                    >
                      {m}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {!noteOpen && (
            <button type="button" className="lg-note-toggle" onClick={() => setNoteOpen(true)}>
              상세 메모
            </button>
          )}
          <button
            type="button"
            className={`lg-memo-save${dirty ? " is-dirty" : ""}${state === "error" ? " is-error" : ""}`}
            // 입력칸의 blur(자동 저장)보다 먼저 눌리지 않게 — 포커스를 그대로 두고 우리가 저장한다
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void saveAll()}
            disabled={state === "saving"}
            title="메모와 상세 메모를 저장 (칸을 벗어나도 저절로 저장돼요)"
            aria-live="polite"
          >
            {state === "saving" ? "저장 중" : state === "saved" ? "저장됨" : state === "error" ? "저장 실패" : "저장"}
          </button>
        </div>
        {offer && (
          <SameOffer onApply={(remember) => void applyOffer(remember)} onDismiss={() => setOffer(null)}>
            같은 가게·같은 금액({won(Math.abs(tx.amount))}원)인데 메모 없는 결제 <strong>{offer.sameAmount}건</strong>에도 &lsquo;{offer.memo}&rsquo; 넣을까?
          </SameOffer>
        )}
        {applied && <p className="lg-memo-applied">{applied}</p>}
        {noteOpen && (
          <div className="lg-note">
            <textarea
              value={note}
              maxLength={2000}
              autoFocus={!tx.note}
              rows={Math.min(12, Math.max(3, note.split("\n").length + 1))}
              placeholder={"상세 메모 (주문 품목 등, 달력에는 안 보여요)\n예) 치킨 콤보 26,000\n떡볶이 6,000"}
              aria-label="상세 메모"
              onChange={(e) => {
                setNote(e.target.value);
                setState("idle");
              }}
              onBlur={saveNote}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setNote(tx.note ?? "");
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        )}
    </div>
  );
}

/* ── 자동완성용 메모 목록: 페이지마다 따로 받지 않게 한 번 받아 같이 쓴다 ── */
let shared: MemoUse[] | null = null;
let loading: Promise<MemoUse[]> | null = null;
const listeners = new Set<(list: MemoUse[]) => void>();
const publish = (list: MemoUse[]) => {
  shared = list;
  listeners.forEach((fn) => fn(list));
};

/** 메모 목록 (처음 쓸 때 한 번 받음). add 는 방금 쓴 메모를 바로 넣고, refresh 는 서버에서 다시 받는다 */
export function useMemoUses(enabled = true) {
  const [list, setList] = useState<MemoUse[]>(shared ?? []);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  useEffect(() => {
    if (!enabled || shared || loading) return;
    loading = ledgerApi.memos().then(
      (l) => (publish(l), l),
      () => [],
    );
  }, [enabled]);
  return {
    memoUses: list,
    addMemoUse: (tx: Transaction, memo: string) =>
      publish([...(shared ?? []), { memo, merchant: tx.rawMerchant ?? tx.merchant, amount: tx.amount, count: 1, last: tx.date }]),
    refreshMemoUses: () => ledgerApi.memos().then(publish, () => {}),
  };
}
