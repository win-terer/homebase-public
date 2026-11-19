import { useState } from "react";
import { parseQuickTime } from "../shared/quick-time.ts";
import type { Category, EventInput } from "./api.ts";

/**
 * 날짜를 누르면 바로 뜨는 **한 줄 추가**.
 *
 * 일정 대부분은 "몇 시에 무엇" 한 줄이다. 그걸 넣으려고 전체 양식(종일 끄기·시·분·반복·장소)을
 * 다 펼치는 건 과하다 — 날짜칸을 누르고 `09:00 치과` 를 치고 엔터, 거기서 끝나는 게 맞다
 * (사용자 요청 2026-10-06). 더 적을 게 있으면 [자세히] 로 전체 양식을 연다.
 *
 * 읽어 낸 시각은 **적기 전에 보여 준다** — `3시` 를 오후로 짐작하지 않고 적은 그대로
 * 03:00 으로 두기 때문에(짐작은 틀렸을 때 조용하다), 무엇으로 읽혔는지가 눈에 보여야 한다.
 */
export function QuickAdd({
  date,
  categories,
  onAdd,
  onDetail,
}: {
  date: string;
  categories: Category[];
  onAdd(input: EventInput): Promise<void>;
  onDetail(seed: { title: string; startTime: string | null; endTime: string | null }): void;
}) {
  const [text, setText] = useState("");
  // 고르기 전에는 첫 카테고리 — 처음 상태로 박아 두면 목록이 늦게 와 '분류 없음' 으로 굳는다
  // (`?date=` 로 바로 열면 실제로 그렇게 됐다)
  const [picked, setPicked] = useState<number | null | undefined>(undefined);
  const categoryId = picked === undefined ? (categories[0]?.id ?? null) : picked;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseQuickTime(text);
  const ready = parsed.title.length > 0 && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd({
        title: parsed.title,
        categoryId,
        startDate: date,
        endDate: date,
        startTime: parsed.startTime,
        endTime: parsed.endTime,
        location: null,
        memo: null,
        repeat: null,
        repeatUntil: null,
      });
      setText("");
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  return (
    <form className="cal-quick" onSubmit={submit}>
      <div className="cal-quick-row">
        {/* 날짜를 누르자마자 바로 칠 수 있게 — 이 상자는 그러려고 뜬다 */}
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input
          className="cal-quick-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="09:00 치과"
          aria-label="일정 제목 (시각을 같이 적으면 떼어 내요)"
          autoFocus
        />
        <button className="hb-button cal-quick-save" disabled={!ready}>
          추가
        </button>
      </div>
      <div className="cal-quick-row">
        <select className="cal-quick-cat" value={categoryId ?? ""} onChange={(e) => setPicked(e.target.value ? Number(e.target.value) : null)} aria-label="카테고리">
          <option value="">분류 없음</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="button" className="lg-text-button cal-quick-more" onClick={() => onDetail(parsed)}>
          자세히
        </button>
      </div>
      {/* 읽은 결과·안내는 **제 줄을 통째로** 쓴다. 분류칸 옆에 끼워 넣었더니 줄임표로 잘려
          (`9시 · 9:…`) 예시가 예시 구실을 못 했다 (사용자 지적 2026-10-06) */}
      <p className={`cal-quick-read ${text.trim() ? "is-read" : ""}`}>
        {text.trim() ? reading(parsed) : "시각을 같이 적으면 떼어 내요 — 9시 · 9:30 · 오후 7시 · 9~11시"}
      </p>
      {error && <p className="hb-error">{error}</p>}
    </form>
  );
}

/** 무엇으로 읽혔는지 한 줄 — `오전 9:00 · 치과` */
function reading(p: { title: string; startTime: string | null; endTime: string | null }): string {
  const when = p.startTime ? [clock(p.startTime), p.endTime ? `~ ${clock(p.endTime)}` : ""].filter(Boolean).join(" ") : "종일";
  return `${when} · ${p.title || "(제목 없음)"}`;
}

/** `19:30` → `오후 7:30` (읽은 결과를 사람 말로 되돌려 보여 준다) */
function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const half = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${half} ${h12}:${String(m).padStart(2, "0")}`;
}
