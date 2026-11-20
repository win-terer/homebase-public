import { useEffect, useState } from "react";
import { NAME_MAX, type Names } from "@homebase/core/presence";
import { calendarApi, COLOR_LABELS, type Category, type SharedCategory } from "./api.ts";

const COLORS = Object.keys(COLOR_LABELS);

/** 카테고리 이름·색 바꾸기, 추가, 삭제 (지우면 그 일정은 카테고리 없음으로 남는다) */
export function CategoryEditor({ categories, onChange, onClose }: { categories: Category[]; onChange(list: Category[]): void; onClose(): void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[(categories.length + 2) % COLORS.length]!);
  const [error, setError] = useState<string | null>(null);
  /** 동거인과 함께 보는 카테고리들 */
  const [shared, setShared] = useState<SharedCategory[]>([]);
  /** 접속 표시에 쓸 이름 ('○○ 보는 중'). **설정에만 둔다** — 코드에 적으면 공개판에 올라간다 */
  const [names, setNames] = useState<Names>({ owner: "", guest: "" });
  useEffect(() => {
    void calendarApi
      .guest()
      .then((r) => {
        setShared(r.categories);
        setNames(r.names);
      })
      .catch(() => setShared([]));
  }, []);
  const saveName = (who: "owner" | "guest", value: string) => {
    if (value === names[who]) return;
    setNames((n) => ({ ...n, [who]: value }));
    void calendarApi.setNames({ [who]: value }).then((r) => setNames(r.names), (e: Error) => setError(e.message));
  };
  const isShared = (id: number) => shared.some((x) => x.id === id);
  /** 한 카테고리를 켜고 끈다. 여러 개를 같이 열 수 있다 */
  const toggleShare = async (id: number) => {
    setError(null);
    const next = isShared(id) ? shared.filter((x) => x.id !== id).map((x) => x.id) : [...shared.map((x) => x.id), id];
    try {
      setShared((await calendarApi.setGuest(next)).categories);
    } catch (e) {
      setError((e as Error).message);
    }
  };
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
            {/* 함께 보기는 **한 카테고리만** — 켜면 전에 켜 둔 것은 저절로 꺼진다.
                카테고리를 만들고 지우는 건 여기(주인 화면)에서만 되고, 동거인에게는 이 화면이 없다 */}
            <button
              type="button"
              className={`lg-text-button cal-share ${isShared(c.id) ? "is-on" : ""}`}
              aria-pressed={isShared(c.id)}
              title={isShared(c.id) ? "동거인도 이 카테고리를 보고 적을 수 있어요" : "이 카테고리를 동거인과 함께 봐요"}
              onClick={() => void toggleShare(c.id)}
            >
              {isShared(c.id) ? "함께 보는 중" : "함께 보기"}
            </button>
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
      {/* 서로를 뭐라고 부를지 — 접속 표시가 '○○ 보는 중' 으로 쓴다 */}
      {shared.length > 0 && (
        <div className="cal-names">
          <label>
            <span>내 이름</span>
            <input
              className="cal-input"
              defaultValue={names.owner}
              maxLength={NAME_MAX}
              placeholder="주인"
              onBlur={(e) => saveName("owner", e.target.value.trim())}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()}
            />
          </label>
          <label>
            <span>동거인 이름</span>
            <input
              className="cal-input"
              defaultValue={names.guest}
              maxLength={NAME_MAX}
              placeholder="동거인"
              onBlur={(e) => saveName("guest", e.target.value.trim())}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && e.currentTarget.blur()}
            />
          </label>
        </div>
      )}

      {/* 지금 누가 무엇을 보는지 한 줄로 — 켜 놓고 잊는 게 제일 곤란하다 */}
      <p className="cal-share-note">
        {shared.length ? (
          <>
            동거인은 <b>{shared.map((x) => x.name).join(" · ")}</b> 일정{shared.length > 1 ? "들" : ""}만 보고 적을 수 있어요. 가계부와 다른 일정은 안
            보여요. 비밀번호는 내 것과 같아요 — OTP 는 안 물어봐요(주인 자리는 OTP 가 막아요).
          </>
        ) : (
          "함께 볼 카테고리에서 [함께 보기] 를 누르면 동거인이 /guest 로 들어올 수 있어요. 여러 개를 켜도 돼요. 켜기 전에는 그 문이 아예 없어요."
        )}
      </p>
      {/* 보낼 주소는 **눈에 보이게 통째로** — '/guest' 라고만 적어 두면 앞에 뭘 붙일지 매번 생각해야 한다 (사용자 요청 2026-11-20) */}
      {shared.length > 0 && <ShareLink />}
      {error && <p className="hb-error">{error}</p>}
    </div>
  );
}

/** 동거인에게 보낼 주소 한 줄 + [복사] */
function ShareLink() {
  const url = `${location.origin}/guest`;
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // 안전하지 않은 연결이거나 권한을 막아 둔 브라우저 — 주소는 보이니 직접 긁어 가면 된다
      return;
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <div className="cal-share-link">
      <input className="cal-input" value={url} readOnly aria-label="동거인에게 보낼 주소" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="hb-button is-secondary" onClick={() => void copy()}>
        {done ? "복사됨" : "복사"}
      </button>
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
