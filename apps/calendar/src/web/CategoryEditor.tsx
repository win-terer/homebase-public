import { useState } from "react";
import { calendarApi, COLOR_LABELS, type Category } from "./api.ts";

const COLORS = Object.keys(COLOR_LABELS);

/** 카테고리 이름·색 바꾸기, 추가, 삭제 (지우면 그 일정은 카테고리 없음으로 남는다) */
export function CategoryEditor({ categories, onChange, onClose }: { categories: Category[]; onChange(list: Category[]): void; onClose(): void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[(categories.length + 2) % COLORS.length]!);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<Category[]>) => {
    setError(null);
    try {
      onChange(await action());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="cal-cats">
      <header className="lg-panel-head">
        <h2>카테고리</h2>
        <button className="lg-icon-button" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </header>
      <p className="hb-muted">달력 위 칩을 누르면 그 카테고리를 끄고 볼 수 있어요.</p>
      <ul>
        {categories.map((c) => (
          <li key={c.id}>
            <ColorPick value={c.color} onPick={(v) => void run(() => calendarApi.updateCategory(c.id, { color: v }))} />
            <input
              className="cal-input"
              defaultValue={c.name}
              maxLength={30}
              aria-label="이름"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== c.name) void run(() => calendarApi.updateCategory(c.id, { name: v }));
              }}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()}
            />
            <button
              className="lg-text-button cal-delete"
              onClick={() => {
                if (confirm(`'${c.name}' 카테고리를 지울까요? 그 일정은 카테고리 없음으로 남아요.`)) void run(() => calendarApi.removeCategory(c.id));
              }}
            >
              삭제
            </button>
          </li>
        ))}
      </ul>
      <form
        className="cal-cat-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void run(() => calendarApi.addCategory(name.trim(), color)).then(() => setName(""));
        }}
      >
        <ColorPick value={color} onPick={setColor} />
        <input className="cal-input" value={name} maxLength={30} placeholder="새 카테고리 (예: 병원·여행)" onChange={(e) => setName(e.target.value)} />
        <button className="hb-button" type="submit">
          추가
        </button>
      </form>
      {error && <p className="hb-error">{error}</p>}
    </div>
  );
}

function ColorPick({ value, onPick }: { value: string; onPick(v: string): void }) {
  return (
    <span className="cal-colors" role="radiogroup" aria-label="색">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c === value}
          aria-label={COLOR_LABELS[c]}
          className={`cal-swatch hb-c-${c} ${c === value ? "is-picked" : ""}`}
          onClick={() => onPick(c)}
        />
      ))}
    </span>
  );
}
