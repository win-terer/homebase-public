import { useLayoutEffect, useRef, useState } from "react";
import { formatDay } from "@homebase/ledger/web/dates.ts";
import { addDays, daysBetween, repeatLabel, timeLabel, type Occurrence, type Repeat } from "../shared/occurrences.ts";
import type { Category, EventInput } from "./api.ts";
import { PhotoStrip } from "@homebase/core/photos-web";

/** 반복 일정을 고치거나 지울 때: 이 회차만 / 모든 반복 */
export type SaveScope = "one" | "all";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const weekdayOf = (d: string) => WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];

/** 받침이 있으면 "을", 없으면 "를". 한글이 아니면 "을" (제목이 영문·숫자로 끝날 때) */
export function objectParticle(word: string): "을" | "를" {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return "을";
  return code % 28 === 0 ? "를" : "을";
}

/** 한 줄 추가에서 [자세히] 로 넘어올 때 들고 오는 것 — 친 제목과 거기서 떼어 낸 시각 */
export interface Seed {
  title: string;
  startTime: string | null;
  endTime: string | null;
}

/**
 * 일정 **보기**. 누르면 바로 수정 폼이 뜨던 것을 바꿨다 — 고치려고 누르는 것보다 그냥 보려고
 * 누르는 일이 많다(2026-11-19 사용자 지적). 고치려면 [수정] 을 한 번 더 누른다.
 *
 * 단 **방금 적은 일정은 바로 수정으로 열린다**(CalendarRoot 의 `RECENT_MS`) — 적자마자
 * 다시 눌렀다면 덜 적었거나 잘못 적은 것이다.
 */
export function EventView({
  occurrence,
  categories,
  onEdit,
  onClose,
}: {
  occurrence: Occurrence;
  categories: Category[];
  onEdit(): void;
  onClose(): void;
}) {
  const e = occurrence.event;
  const cat = categories.find((c) => c.id === e.categoryId);
  const time = timeLabel(occurrence);
  const span = occurrence.start === occurrence.end ? "" : ` ~ ${formatDay(occurrence.end)}`;
  const repeat = repeatLabel(e);
  return (
    <div className="cal-view">
      <header className="lg-panel-head">
        <h2>일정</h2>
        <button className="lg-icon-button" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </header>

      <h3 className="cal-view-title">{e.title}</h3>
      {cat && (
        <span className={`cal-chip hb-c-${cat.color} is-picked cal-view-cat`}>
          <span className="cal-dot" aria-hidden="true" />
          {cat.name}
        </span>
      )}

      <dl className="cal-view-list">
        <dt>언제</dt>
        <dd>
          {formatDay(occurrence.start)}
          {span} · {time || "종일"}
        </dd>
        {repeat && (
          <>
            <dt>반복</dt>
            <dd>{repeat}</dd>
          </>
        )}
        {e.location && (
          <>
            <dt>장소</dt>
            <dd>{e.location}</dd>
          </>
        )}
      </dl>

      {e.memo && <p className="cal-view-memo">{e.memo}</p>}
      <PhotoStrip app="calendar" refId={e.id} />

      <div className="cal-view-foot">
        <button className="hb-button" onClick={onEdit}>
          수정
        </button>
      </div>
    </div>
  );
}

/** 일정 추가·수정. 반복 일정의 한 회차를 열었으면 날짜는 그 회차 기준으로 보여준다 */
export function EventForm({
  date,
  occurrence,
  seed,
  categories,
  onSave,
  onDelete,
  onCancel,
}: {
  date: string;
  occurrence: Occurrence | null;
  /** 새로 만들 때만 — 한 줄 추가에서 치던 것을 이어받는다 */
  seed?: Seed | null;
  categories: Category[];
  onSave(input: EventInput, scope: SaveScope): Promise<void>;
  onDelete(scope: SaveScope): Promise<void>;
  onCancel(): void;
}) {
  const e = occurrence?.event;
  const repeating = Boolean(e?.repeat);
  const [title, setTitle] = useState(e?.title ?? seed?.title ?? "");
  const [categoryId, setCategoryId] = useState<number | null>(e ? e.categoryId : (categories[0]?.id ?? null));
  const [allDay, setAllDay] = useState(e ? !e.startTime : !seed?.startTime);
  const [startDate, setStartDate] = useState(occurrence?.start ?? date);
  const [endDate, setEndDate] = useState(occurrence?.end ?? date);
  const [startTime, setStartTime] = useState(e?.startTime ?? seed?.startTime ?? "09:00");
  const [endTime, setEndTime] = useState(e?.endTime ?? seed?.endTime ?? "");
  const [location, setLocation] = useState(e?.location ?? "");
  const [memo, setMemo] = useState(e?.memo ?? "");
  const [repeat, setRepeat] = useState<Repeat | "">(e?.repeat ?? "");
  const [repeatUntil, setRepeatUntil] = useState(e?.repeatUntil ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 되묻는 칸. 반복 일정은 저장·삭제 **범위**(이 회차만/모든 반복)를 묻고,
   * 한 번짜리 일정은 삭제만 **정말 지울지**를 묻는다 — 지우면 되돌릴 수 없어서다.
   */
  const [ask, setAsk] = useState<"save" | "delete" | null>(null);

  /**
   * 메모 칸은 **적은 만큼 늘어난다** (2026-11-16 사용자 요청 — 3줄에 갇혀 안에서만 굴러갔다).
   * 줄 수를 세지 않고 실제 내용 높이(`scrollHeight`)로 맞춘다 — 긴 줄이 접힌 것까지 들어간다.
   * 먼저 `auto` 로 되돌리는 건 지운 뒤에도 줄어들게 하려는 것(scrollHeight 는 안 줄어든다).
   * 상한은 CSS(`.cal-memo`), 넘으면 그때부터 안에서 굴러간다. 팝업은 늘어난 만큼 따라 커진다.
   */
  const memoEl = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = memoEl.current;
    if (!el) return;
    el.style.height = "auto";
    // `box-sizing: border-box` 라 테두리까지 더해야 한다 — 안 더하면 2px 이 모자라 스크롤 막대가 선다
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [memo]);

  const input = (scope: SaveScope): EventInput => {
    // 모든 반복을 고칠 때는 처음 시작일을 그대로 두고, 이 회차에서 옮긴 만큼만 옮긴다
    const shift = scope === "all" && occurrence && e ? daysBetween(occurrence.start, startDate) : 0;
    const start = scope === "all" && e ? addDays(e.startDate, shift) : startDate;
    const span = Math.max(0, daysBetween(startDate, endDate));
    return {
      title,
      categoryId,
      startDate: start,
      endDate: addDays(start, span),
      startTime: allDay ? null : startTime || null,
      endTime: allDay ? null : endTime || null,
      location: location || null,
      memo: memo || null,
      repeat: scope === "one" ? null : repeat || null,
      repeatUntil: scope === "one" || !repeat ? null : repeatUntil || null,
    };
  };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const submit = () => {
    if (!title.trim()) return setError("제목을 적어 주세요.");
    if (repeating) return setAsk("save");
    void run(() => onSave(input("all"), "all"));
  };

  return (
    <form
      data-photo-target={e ? `calendar:${e.id}` : undefined}
      className="cal-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
    >
      <header className="lg-panel-head">
        <h2>{e ? "일정 수정" : "일정 추가"}</h2>
        <button type="button" className="lg-icon-button" onClick={onCancel} aria-label="닫기">
          ✕
        </button>
      </header>

      <input className="cal-input cal-title-input" value={title} autoFocus={!e} maxLength={200} placeholder="제목" onChange={(ev) => setTitle(ev.target.value)} />

      <div className="cal-field">
        <span>카테고리</span>
        <div className="cal-cat-pick">
          {categories.map((c) => (
            <button type="button" key={c.id} className={`cal-chip hb-c-${c.color} ${categoryId === c.id ? "is-picked" : ""}`} onClick={() => setCategoryId(c.id)}>
              <span className="cal-dot" aria-hidden="true" />
              {c.name}
            </button>
          ))}
        </div>
      </div>

      <div className="cal-field">
        <span>날짜</span>
        <div className="cal-when">
          <label className="cal-check">
            <input type="checkbox" checked={allDay} onChange={(ev) => setAllDay(ev.target.checked)} /> 종일
          </label>
          <div className="cal-when-row">
            <input
              type="date"
              className="cal-input"
              value={startDate}
              onChange={(ev) => {
                const v = ev.target.value;
                if (!v) return;
                // 시작을 옮기면 길이를 유지한 채 끝도 옮긴다
                setEndDate(addDays(v, Math.max(0, daysBetween(startDate, endDate))));
                setStartDate(v);
              }}
            />
            {!allDay && <input type="time" className="cal-input" value={startTime} onChange={(ev) => setStartTime(ev.target.value)} />}
            <span className="hb-muted">~</span>
            <input type="date" className="cal-input" value={endDate} min={startDate} onChange={(ev) => ev.target.value && setEndDate(ev.target.value)} />
            {!allDay && <input type="time" className="cal-input" value={endTime} onChange={(ev) => setEndTime(ev.target.value)} />}
          </div>
        </div>
      </div>

      <label className="cal-field">
        <span>장소</span>
        <input className="cal-input" value={location} maxLength={200} placeholder="장소" onChange={(ev) => setLocation(ev.target.value)} />
      </label>

      <label className="cal-field">
        <span>메모</span>
        <textarea ref={memoEl} className="cal-input cal-memo" value={memo} rows={3} maxLength={2000} placeholder="메모" onChange={(ev) => setMemo(ev.target.value)} />
      </label>

      {/* 사진은 저장 버튼과 상관없이 바로 올라간다 (일정에 붙음 — 반복 일정이면 모든 회차에 같이 보인다) */}
      <div className="cal-field">
        <span>사진</span>
        {e ? <PhotoStrip app="calendar" refId={e.id} /> : <span className="hb-muted cal-photo-later">일정을 저장한 뒤 붙일 수 있어요 (3장까지)</span>}
      </div>

      <div className="cal-field">
        <span>반복</span>
        <div className="cal-when-row">
          <select className="cal-input" value={repeat} onChange={(ev) => setRepeat(ev.target.value as Repeat | "")}>
            <option value="">안 함</option>
            <option value="weekly">매주 {weekdayOf(startDate)}요일</option>
            <option value="monthly">매달 {+startDate.slice(8, 10)}일</option>
            <option value="yearly">
              매년 {+startDate.slice(5, 7)}월 {+startDate.slice(8, 10)}일
            </option>
          </select>
          {repeat && (
            <>
              <input type="date" className="cal-input" value={repeatUntil} min={startDate} onChange={(ev) => setRepeatUntil(ev.target.value)} aria-label="반복 끝" />
              <span className="hb-muted">{repeatUntil ? "까지" : "끝 날짜 (비우면 계속)"}</span>
            </>
          )}
        </div>
      </div>

      {error && <p className="hb-error">{error}</p>}

      {ask === "delete" && !repeating ? (
        <div className="cal-ask">
          <p>
            <strong>{title.trim() || "이 일정"}</strong>
            {objectParticle(title.trim() || "이 일정")} 지울까요? 되돌릴 수 없어요.
          </p>
          <div className="cal-actions">
            <button type="button" className="hb-button is-danger" disabled={busy} onClick={() => void run(() => onDelete("all"))}>
              지우기
            </button>
            <button type="button" className="hb-button is-secondary" onClick={() => setAsk(null)}>
              취소
            </button>
          </div>
        </div>
      ) : ask ? (
        <div className="cal-ask">
          <p>
            반복 일정이에요. {ask === "save" ? "어디까지 바꿀까요?" : "어디까지 지울까요?"}
          </p>
          <div className="cal-actions">
            <button
              type="button"
              className="hb-button"
              disabled={busy}
              onClick={() => void run(() => (ask === "save" ? onSave(input("one"), "one") : onDelete("one")))}
            >
              {occurrence ? formatDay(occurrence.start) : ""}만
            </button>
            <button
              type="button"
              className={ask === "save" ? "hb-button is-secondary" : "hb-button is-danger"}
              disabled={busy}
              onClick={() => void run(() => (ask === "save" ? onSave(input("all"), "all") : onDelete("all")))}
            >
              모든 반복
            </button>
            <button type="button" className="lg-text-button" onClick={() => setAsk(null)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <div className="cal-actions">
          <button type="submit" className="hb-button" disabled={busy}>
            저장
          </button>
          <button type="button" className="hb-button is-secondary" onClick={onCancel}>
            취소
          </button>
          {e && (
            <button
              type="button"
              className="lg-text-button cal-delete"
              disabled={busy}
              onClick={() => setAsk("delete")}
            >
              삭제
            </button>
          )}
        </div>
      )}
    </form>
  );
}
