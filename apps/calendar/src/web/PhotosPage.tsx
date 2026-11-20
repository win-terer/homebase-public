/**
 * 사진 모아 보기 — 그 달 일정에 붙은 사진을 한눈에.
 *
 * **한 달씩 · 썸네일만 · lazy** 세 가지를 지킨다. 사진이 쌓여도 한 번에 받는 양이 일정하고
 * (한 달 90장 ≈ 2.2MB, 보이는 것만 받으면 그보다 훨씬 적다), 사진 주소는 1년 immutable 이라
 * 두 번째부터는 네트워크를 타지 않는다. 원본(1600px)은 눌렀을 때만 받는다.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { photoUrl } from "@homebase/core/photos-web";
import { addMonths, formatDay, formatMonth, monthGrid, today } from "@homebase/ledger/web/dates.ts";
import { calendarApi, type Category, type MonthPhoto } from "./api.ts";

export function PhotosPage({ guest = false }: { guest?: boolean }) {
  const [month, setMonth] = useState(() => today().slice(0, 7));
  const [photos, setPhotos] = useState<MonthPhoto[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<MonthPhoto | null>(null);

  // 달력 격자가 아니라 **그 달만** — 모아 보기는 앞뒤 달 사진이 섞이면 헷갈린다
  const days = monthGrid(month);
  const from = `${month}-01`;
  const to = days.filter((d) => d.startsWith(month)).at(-1) ?? from;

  const load = useCallback(() => {
    setError(null);
    setPhotos(null);
    calendarApi.monthPhotos(from, to).then(
      (r) => setPhotos(r.photos),
      (e: Error) => setError(e.message),
    );
  }, [from, to]);
  useEffect(load, [load]);

  // 분류 색을 쓰려고 한 번만 받는다 (일정 목록과 같은 응답)
  useEffect(() => {
    calendarApi.events(from, to).then((r) => setCategories(r.categories), () => {});
  }, [from, to]);
  const colorOf = (id: number | null) => categories.find((c) => c.id === id)?.color ?? "gray";

  // 크게 본 사진은 Esc 로 닫는다
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);

  return (
    <section className="lg-page cal-photos">
      <div className="lg-toolbar">
        <div className="lg-month-nav">
          <h1>{formatMonth(month)}</h1>
          <div className="lg-nav-group">
            <button className="lg-icon-button" onClick={() => setMonth(addMonths(month, -1))} aria-label="이전 달">
              ‹
            </button>
            <button className="lg-text-button" onClick={() => setMonth(today().slice(0, 7))}>
              이번 달
            </button>
            <button className="lg-icon-button" onClick={() => setMonth(addMonths(month, 1))} aria-label="다음 달">
              ›
            </button>
          </div>
        </div>
        <div className="cal-filters">
          <Link className="cal-tool" to={guest ? "/" : "/calendar"}>
            달력으로
          </Link>
        </div>
      </div>

      {error && <p className="hb-error">{error}</p>}
      {photos !== null && photos.length === 0 && <p className="hb-muted">이 달에는 붙인 사진이 없어요.</p>}

      <div className="cal-photo-grid">
        {photos?.map((p) => (
          <button key={p.id} className="cal-photo-cell" onClick={() => setOpen(p)} title={`${formatDay(p.date)} · ${p.title}`}>
            {/* 썸네일만. loading=lazy 라 보이는 것부터 받는다 */}
            <img src={photoUrl(p.id, true)} alt={p.title} loading="lazy" decoding="async" />
            <span className={`cal-photo-cap hb-c-${colorOf(p.categoryId)}`}>
              <i className="cal-dot" aria-hidden="true" />
              <b>{formatDay(p.date)}</b>
              {p.title}
            </span>
          </button>
        ))}
      </div>

      {open && (
        <div className="cal-photo-full" onClick={() => setOpen(null)} role="presentation">
          {/* 여기서만 원본(긴 변 1600px)을 받는다 */}
          <img src={photoUrl(open.id)} alt={open.title} />
          <p>
            {formatDay(open.date)} · {open.title}
          </p>
        </div>
      )}
    </section>
  );
}
