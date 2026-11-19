import { useEffect, useState, type RefObject } from "react";

/**
 * 달력을 **화면 바닥까지 꼭 맞게** 늘린다 — 스크롤이 안 생기는 선에서.
 * 가계부 달력과 일정 달력이 같은 걸 쓴다.
 *
 * 빼기로 잡은 숫자(`calc(100vh - 230px)`)는 추측이라, 도구줄이 한 줄이냐 두 줄이냐에 따라
 * 모자라거나 넘쳤다. 그래서 **재서** 정한다: 달력이 시작하는 자리부터 화면 바닥까지가 쓸 수
 * 있는 높이이고, 그걸 날짜 줄 수로 나눠 **줄 하나의 높이**까지 정한다.
 *
 * 돌려주는 줄 높이로 칸에 **몇 줄이 들어가는지** 센다 — 높이를 못 박으면 넘치는 줄은 잘리고,
 * 잘린 수는 `+N건 더` 가 말해 줘야 하기 때문이다.
 *
 * 함정 둘:
 * - **`1fr` 은 정해진 높이가 있어야 나눠 쓴다.** `min-height` 로만 주면 줄이 내용대로 커지고,
 *   칸 하나가 길면 **모든 줄이 따라 커진다**. 쓰는 쪽에서 `height` 로 박아야 한다.
 * - **아래 여백을 `scrollHeight` 로 재면 안 된다.** 내용이 화면보다 짧으면 화면 높이로
 *   올라붙어서, 없는 여백을 있다고 보고 달력을 안 늘린다(1055 짜리 창에서 330px 을 날렸다).
 */

/** 칸 안 한 줄의 높이 */
export const ITEM_PX = 22;
/** 날짜 머리와 위아래 여백 — 줄이 들어갈 자리를 셀 때 빼 둔다 */
export const CELL_CHROME = 40;
/** 날짜 줄을 이보다 낮게는 눌러 담지 않는다 — 날짜와 한두 줄은 보여야 한다 */
const ROW_FLOOR = 76;

export function useFillHeight(ref: RefObject<HTMLDivElement | null>, rows: number, on: boolean): number | null {
  const [rowPx, setRowPx] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !rows) return;
    const clear = () => {
      el.style.removeProperty("--cal-fill");
      el.style.removeProperty("--cal-row");
      setRowPx(null);
    };
    if (!on) return clear();
    const fit = () => {
      clear();
      const head = el.firstElementChild?.getBoundingClientRect().height ?? 0;
      const box = el.getBoundingClientRect();
      const top = box.top + window.scrollY;
      const bottom = document.body.getBoundingClientRect().bottom + window.scrollY;
      const below = Math.max(0, bottom - (top + box.height));
      const room = window.innerHeight - top - below;
      // 날짜 줄이 나눠 가질 높이 — 요일 머리와 칸 사이 선(1px)을 빼고 고르게
      const perRow = Math.floor((room - head - rows - 2) / rows);
      if (perRow < ROW_FLOOR) return; // 이보다 좁으면 억지로 누르지 않고 내용대로 둔다
      el.style.setProperty("--cal-row", `${perRow}px`);
      el.style.setProperty("--cal-fill", `${room}px`);
      setRowPx((was) => (was === perRow ? was : perRow));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [ref, rows, on]);
  return rowPx;
}

/** 줄 높이로 센 "칸 하나에 들어가는 줄 수". 아직 못 쟀으면 기본값 */
export function itemsThatFit(rowPx: number | null, fallback: number): number {
  return rowPx ? Math.max(1, Math.floor((rowPx - CELL_CHROME) / ITEM_PX)) : fallback;
}

/** 넓은 화면인가 (ledger.css 의 1100px 기준과 같게) */
export function useWide(): boolean {
  const query = "(min-width: 1101px)";
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}
