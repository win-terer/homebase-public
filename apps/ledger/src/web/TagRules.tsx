import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ledgerApi, type TagRule } from "./api.ts";

/**
 * 태그 규칙 관리 — 메모에 이 말이 있으면 이 태그를 붙인다.
 *
 * 분류는 한 가지로만 나뉘어서, 한 묶음을 여러 결로 보고 싶을 때(반려견에게 쓴 돈 — 병원이기도
 * 하고 쇼핑이기도 하다) 분류를 덮으면 원래 쓰임이 사라진다. 태그는 분류를 건드리지 않고 옆에 붙는다.
 *
 * 태그는 저장하지 않고 **메모에서 그때그때 뽑는다**(server/tags.ts) — 규칙을 넣으면 예전 기록에도
 * 바로 붙고, 지우면 흔적 없이 사라진다.
 */
export function TagRules() {
  const [rules, setRules] = useState<TagRule[] | null>(null);
  const [word, setWord] = useState("");
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ledgerApi.tagRules().then((r) => setRules(r.rules), (e: Error) => setError(e.message));
  }, []);

  async function run(action: () => Promise<{ rules: TagRule[] }>) {
    setBusy(true);
    setError(null);
    try {
      setRules((await action()).rules);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function add() {
    const w = word.trim();
    const t = tag.trim() || w; // 태그 이름을 안 적으면 찾는 말을 그대로 쓴다
    if (!w) return;
    void run(() => ledgerApi.addTagRule(w, t)).then(() => {
      setWord("");
      setTag("");
    });
  }

  return (
    <div className="ct-tags">
      <h2>태그</h2>
      <p className="hb-muted">
        메모에 적은 말로 태그가 붙어요. 분류는 그대로 두고 <b>옆에</b> 붙습니다 — 예전에 적어 둔 메모에도 바로 붙어요.
        태그를 누르면 그 태그가 붙은 결제를 모아 보고, 통계에도 태그별 합계가 나와요.
      </p>
      {error && <p className="hb-error">{error}</p>}
      {!rules ? (
        <p className="hb-muted">불러오는 중…</p>
      ) : (
        <ul className="ct-tag-list">
          {rules.map((r) => (
            <li key={r.word}>
              <span className="ct-tag-word">메모에 “{r.word}”</span>
              <span className="ct-tag-arrow">→</span>
              <Link className="lg-tag lg-tag-user" to={`/ledger/search?q=${encodeURIComponent(`#${r.tag}`)}`}>
                #{r.tag}
              </Link>
              <button type="button" className="ct-tag-del" disabled={busy} title="이 규칙 지우기" onClick={() => void run(() => ledgerApi.removeTagRule(r.word))}>
                ✕
              </button>
            </li>
          ))}
          {rules.length === 0 && <li className="hb-muted">아직 없어요.</li>}
        </ul>
      )}
      <div className="ct-tag-add">
        <input
          value={word}
          maxLength={30}
          placeholder="메모에서 찾을 말 (예: 몽이)"
          aria-label="메모에서 찾을 말"
          onChange={(e) => setWord(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()}
        />
        <span className="ct-tag-arrow">→</span>
        <input
          value={tag}
          maxLength={20}
          placeholder="태그 이름 (비우면 같은 말)"
          aria-label="태그 이름"
          onChange={(e) => setTag(e.target.value.replace(/\s+/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()}
        />
        <button type="button" className="hb-button" disabled={busy || !word.trim()} onClick={add}>
          추가
        </button>
      </div>
    </div>
  );
}
