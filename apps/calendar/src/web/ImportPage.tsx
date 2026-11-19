import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { unzipSync } from "fflate";
import { won } from "@homebase/ledger/web/api.ts";
import { parseIcs, sinceDate, type IcsCalendar, type IcsEvent } from "../importers/ics.ts";
import { calendarApi, COLOR_LABELS, type Category, type NoteItem } from "./api.ts";

const COLORS = Object.keys(COLOR_LABELS);
const DEFAULT_FROM = "2024-09-01";
const CHUNK = 300;

interface Pick {
  category: string;
  /** 금액 붙은 기록도 일정으로 */
  withMoney: boolean;
  skip: boolean;
}

/** .ics 또는 구글 캘린더 내보내기 zip → 캘린더들 (브라우저에서만 읽는다) */
async function readFiles(files: FileList): Promise<IcsCalendar[]> {
  const out: IcsCalendar[] = [];
  const dec = new TextDecoder("utf-8");
  for (const f of Array.from(files)) {
    const buf = new Uint8Array(await f.arrayBuffer());
    if (f.name.toLowerCase().endsWith(".zip")) {
      for (const [name, data] of Object.entries(unzipSync(buf))) if (name.toLowerCase().endsWith(".ics")) out.push(parseIcs(dec.decode(data), name.replace(/\.ics$/i, "")));
    } else out.push(parseIcs(dec.decode(buf), f.name.replace(/\.ics$/i, "")));
  }
  return out;
}

/** 서버 검사에 걸리지 않게 다듬기 (끝 시각이 시작보다 앞이면 끝 시각 없음, 반복 끝이 시작 전이면 반복 없음) */
function toPayload(e: IcsEvent, category: string) {
  const badEnd = e.startTime && e.endTime && e.startDate === e.endDate && e.endTime < e.startTime;
  const badUntil = e.repeat && e.repeatUntil && e.repeatUntil < e.startDate;
  return {
    sourceUid: e.uid,
    category,
    title: e.title.slice(0, 200),
    startDate: e.startDate,
    endDate: e.endDate,
    startTime: e.startTime,
    endTime: badEnd ? null : e.endTime,
    location: e.location,
    memo: e.description?.slice(0, 2000) ?? null,
    repeat: badUntil ? null : e.repeat,
    repeatUntil: badUntil ? null : e.repeatUntil,
    skipDates: e.skipDates,
  };
}

/**
 * 구글 캘린더 가져오기: 캘린더마다 카테고리를 고르고, 금액 붙은 기록(예전 지출 기록)은 빼고, 시작일 이후만.
 * 아래에서 그 지출 기록의 상세 메모를 가계부 거래 상세 메모로 넣을 수 있다.
 */
export function ImportPage() {
  const [calendars, setCalendars] = useState<IcsCalendar[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [from, setFrom] = useState(DEFAULT_FROM);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<Category[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ inserted: number; duplicates: number } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    calendarApi.importedUids().then((u) => setExisting(new Set(u)), () => {});
    calendarApi.events("2000-01-01", "2000-01-01").then((r) => setCategories(r.categories), () => {});
  }, [result]);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setResult(null);
    try {
      const cals = await readFiles(files);
      setCalendars(cals);
      // 기본 캘린더(메일 주소 이름)는 '일정' 카테고리로, 나머지는 캘린더 이름 그대로
      setPicks(cals.map((c) => ({ category: c.name.includes("@") ? "일정" : c.name, withMoney: false, skip: false })));
    } catch (e) {
      setError(`파일을 읽지 못했어요: ${(e as Error).message}`);
    }
  }

  const rows = useMemo(
    () =>
      calendars.map((c, i) => {
        const pick = picks[i]!;
        const events = sinceDate([...c.events, ...(pick.withMoney ? c.moneyEvents : [])], from);
        const fresh = events.filter((e) => !existing.has(e.uid));
        return { c, pick, events, fresh, repeats: events.filter((e) => e.repeat).length, moneySince: c.money.filter((m) => m.date >= from).length };
      }),
    [calendars, picks, from, existing],
  );
  const toImport = rows.filter((r) => !r.pick.skip).flatMap((r) => r.fresh.map((e) => toPayload(e, r.pick.category.trim() || "일정")));

  async function runImport() {
    setBusy(true);
    setError(null);
    try {
      // 새 카테고리 색은 이미 쓰는 색을 피해서 돌아가며
      const known = new Map(categories.map((c) => [c.name, c.color]));
      const used = new Set(categories.map((c) => c.color));
      const free = [...COLORS.filter((c) => !used.has(c)), ...COLORS];
      const newCats = [...new Set(toImport.map((e) => e.category))].filter((n) => !known.has(n)).map((name, i) => ({ name, color: free[i % free.length]! }));
      let inserted = 0;
      let duplicates = 0;
      for (let i = 0; i < Math.max(1, toImport.length); i += CHUNK) {
        setProgress(`${Math.min(i + CHUNK, toImport.length).toLocaleString()} / ${toImport.length.toLocaleString()}`);
        const r = await calendarApi.importEvents(i === 0 ? newCats : [], toImport.slice(i, i + CHUNK));
        inserted += r.inserted;
        duplicates += r.duplicates;
      }
      setResult({ inserted, duplicates });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const noteItems: NoteItem[] = calendars.flatMap((c) =>
    c.money.filter((m) => m.description).map((m) => ({ date: m.date, amount: m.amount, title: m.title, note: m.description! })),
  );

  return (
    <section className="lg-page cal-import">
      <div className="lg-toolbar">
        <div className="lg-month-nav">
          <h1>구글 캘린더 가져오기</h1>
        </div>
        <Link className="lg-text-button" to="/calendar">
          일정으로 돌아가기
        </Link>
      </div>

      <div className="hb-card cal-import-card">
        <p className="hb-muted">
          구글 캘린더 → 설정 → 가져오기/내보내기 → 내보내기 로 받은 zip(또는 .ics)을 고르세요. 파일은 이 브라우저에서만 읽고, 일정으로 옮길 내용만 저장해요.
        </p>
        <div className="cal-import-pick">
          <input type="file" accept=".ics,.zip" multiple onChange={(e) => void onFiles(e.target.files)} />
          <label>
            <span className="hb-muted">이 날짜부터</span>
            <input type="date" className="cal-input" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </label>
        </div>
        {error && <p className="hb-error">{error}</p>}
      </div>

      {rows.length > 0 && (
        <div className="hb-card cal-import-card">
          <table className="cal-import-table">
            <thead>
              <tr>
                <th>캘린더</th>
                <th>가져올 일정</th>
                <th>금액 붙은 기록</th>
                <th>카테고리</th>
                <th>빼기</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={r.pick.skip ? "is-skipped" : ""}>
                  <td>{r.c.name}</td>
                  <td className="num">
                    {r.fresh.length.toLocaleString()}개
                    <span className="hb-muted">
                      {r.repeats > 0 && ` · 반복 ${r.repeats}`}
                      {r.events.length > r.fresh.length && ` · 이미 있음 ${r.events.length - r.fresh.length}`}
                      {r.c.tooLong > 0 && ` · 너무 긴 일정 ${r.c.tooLong} 뺌`}
                    </span>
                  </td>
                  <td>
                    <span className="num">{r.moneySince.toLocaleString()}개</span>{" "}
                    <label className="cal-check">
                      <input type="checkbox" checked={r.pick.withMoney} onChange={(e) => setPicks((p) => p.map((x, j) => (j === i ? { ...x, withMoney: e.target.checked } : x)))} />
                      일정으로도
                    </label>
                  </td>
                  <td>
                    <input
                      className="cal-input"
                      list="cal-import-cats"
                      value={r.pick.category}
                      maxLength={30}
                      onChange={(e) => setPicks((p) => p.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)))}
                    />
                  </td>
                  <td>
                    <input type="checkbox" checked={r.pick.skip} aria-label="이 캘린더 빼기" onChange={(e) => setPicks((p) => p.map((x, j) => (j === i ? { ...x, skip: e.target.checked } : x)))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="cal-import-cats">
            {categories.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
          <p className="hb-muted cal-import-note">
            금액 붙은 기록은 제목이 `가게 0.89`처럼 숫자로 끝나는 예전 지출 기록이에요. 지출은 가계부가 맡으니 기본으로 빼요. 없는 카테고리는 새로 만들어요.
          </p>
          <div className="cal-actions">
            <button className="hb-button" disabled={busy || toImport.length === 0} onClick={() => void runImport()}>
              {busy ? `가져오는 중 ${progress ?? ""}` : `일정 ${toImport.length.toLocaleString()}개 가져오기`}
            </button>
            {result && (
              <span>
                {result.inserted.toLocaleString()}개 넣음{result.duplicates > 0 && ` · ${result.duplicates.toLocaleString()}개는 이미 있음`} ·{" "}
                <Link to="/calendar">일정 보기</Link>
              </span>
            )}
          </div>
        </div>
      )}

      {noteItems.length > 0 && <NoteFill items={noteItems} />}
    </section>
  );
}

/** 예전 지출 기록의 상세 메모 → 가계부 거래 상세 메모 (같은 날·같은 금액) */
function NoteFill({ items }: { items: NoteItem[] }) {
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof calendarApi.notesPreview>> | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="hb-card cal-import-card">
      <h2 className="hb-card-title">가계부에 상세 메모 넣기</h2>
      <p className="hb-muted">
        금액 붙은 기록 중 상세 메모(주문 내용 등)가 있는 것이 {items.length.toLocaleString()}개 있어요. 가계부에서 같은 날·같은 금액인 거래를 찾아 상세 메모로 넣어요. 이미 상세 메모가 있는 거래는 그대로 둬요. 가계부에 아직 없는 기간은 나중에 거래를 가져온 뒤 다시 하면 돼요.
      </p>
      <div className="cal-actions">
        <button className="hb-button is-secondary" disabled={busy} onClick={() => void run(async () => setPreview(await calendarApi.notesPreview(items)))}>
          가계부와 맞춰보기
        </button>
        {preview && preview.matched > 0 && applied === null && (
          <button className="hb-button" disabled={busy} onClick={() => void run(async () => setApplied((await calendarApi.notesApply(items)).applied))}>
            {preview.matched.toLocaleString()}건에 넣기
          </button>
        )}
      </div>
      {preview && (
        <p>
          맞는 거래 <strong>{preview.matched.toLocaleString()}</strong>건 · 이미 상세 메모 있음 {preview.already.toLocaleString()} · 가계부에 없음 {preview.unmatched.toLocaleString()}
        </p>
      )}
      {preview && preview.samples.length > 0 && applied === null && (
        <ul className="cal-import-samples">
          {preview.samples.map((s, i) => (
            <li key={i}>
              <span className="hb-muted">{s.date}</span> {s.merchant} <span className="num">{won(s.amount)}</span> → {s.note}
            </li>
          ))}
        </ul>
      )}
      {applied !== null && <p>{applied.toLocaleString()}건에 상세 메모를 넣었어요.</p>}
      {error && <p className="hb-error">{error}</p>}
    </div>
  );
}
