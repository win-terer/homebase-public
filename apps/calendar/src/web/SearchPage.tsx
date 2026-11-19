import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { formatDay, today } from "@homebase/ledger/web/dates.ts";
import { repeatLabel, type CalendarEvent } from "../shared/occurrences.ts";
import { calendarApi, type Category } from "./api.ts";

/**
 * 일정 검색 — 제목·장소·메모·카테고리 이름.
 *
 * 반복 일정은 **오늘 기준 다음 회차**를 보여 준다(없으면 마지막 회차). 2년 전에 시작한 매주
 * 일정의 시작일을 보여 줘 봐야 "언제 하는 거지" 에 답이 안 된다 — 날짜를 정하는 건 서버의
 * `searchDates()`, 여기서는 받은 날짜를 그대로 쓴다.
 */
interface Hit {
  event: CalendarEvent;
  date: string;
}

export function CalendarSearchPage() {
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";
  const [data, setData] = useState<{ results: Hit[]; more: boolean; categories: Category[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const todayDate = today();

  useEffect(() => {
    setData(null);
    setError(null);
    if (!q.trim()) return;
    calendarApi.search(q).then(setData, (e: Error) => setError(e.message));
  }, [q]);

  const byId = new Map((data?.categories ?? []).map((c) => [c.id, c]));

  return (
    <section className="lg-page sr-page">
      <div className="lg-toolbar">
        <h1>일정 검색</h1>
      </div>
      <CalendarSearchBox initial={q} autoFocus className="sr-box" />
      {error && <p className="hb-error">{error}</p>}
      {!q.trim() ? (
        <p className="hb-muted">제목·장소·메모·카테고리에서 찾아요. 띄어쓰기로 여러 말을 적으면 모두 맞는 일정만 보여요.</p>
      ) : !data ? (
        <p className="hb-muted">찾는 중…</p>
      ) : data.results.length === 0 ? (
        <p className="hb-muted">맞는 일정이 없어요.</p>
      ) : (
        <>
          <p className="sr-count">
            {data.results.length}건{data.more && " 넘음 (최근 것부터 200건)"}
          </p>
          <ul className="cal-rows cal-search-rows">
            {data.results.map(({ event, date }) => {
              const c = event.categoryId !== null ? byId.get(event.categoryId) : undefined;
              const repeat = repeatLabel(event);
              return (
                <li key={event.id}>
                  <Link className={`cal-row hb-c-${c?.color ?? "gray"}`} to={`/calendar?month=${date.slice(0, 7)}&date=${date}`}>
                    <span className="cal-row-bar" aria-hidden="true" />
                    <span className="cal-row-time">
                      {formatDay(date)}
                      {/* 반복 일정은 '그날 하나' 가 아니라 '다음은 이날' 이라서 언제 것인지 적어 준다 */}
                      {repeat && <span className="cal-search-when">{date >= todayDate ? "다음" : "마지막"}</span>}
                    </span>
                    <span className="cal-row-main">
                      <span className="cal-row-title">{event.title}</span>
                      <span className="cal-row-meta">{[c?.name, event.startTime ?? "종일", repeat].filter(Boolean).join(" · ")}</span>
                      {event.location && <span className="cal-row-place">{event.location}</span>}
                      {event.memo && <span className="cal-row-memo">{event.memo}</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** 일정 검색 입력칸 (달력 위 도구 줄과 검색 화면이 같이 쓴다) */
export function CalendarSearchBox({ initial = "", autoFocus = false, className = "" }: { initial?: string; autoFocus?: boolean; className?: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  return (
    <form
      role="search"
      className={`lg-search ${className}`}
      onSubmit={(e) => {
        e.preventDefault();
        const query = value.trim();
        if (query) navigate(`/calendar/search?q=${encodeURIComponent(query)}`);
      }}
    >
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        maxLength={50}
        placeholder="일정 검색 (제목·장소·메모)"
        aria-label="일정 검색"
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // 한글 조합 중 Enter 는 글자를 확정하는 것이지 보내라는 뜻이 아니다
          if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault();
        }}
      />
    </form>
  );
}
