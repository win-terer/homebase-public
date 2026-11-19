import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * 날짜칸을 누르면 그 칸 **옆**에 뜨는 날짜 상세 상자 (PC). 오른쪽 고정 패널 대신이다 — 달력이 화면을
 * 다 쓰게 하려고(사용자 결정 2026-10-03, 어색하면 가운데 모달로 바꾸기로 함).
 *
 * - 칸의 오른쪽에 두고, 오른쪽이 모자라면 왼쪽에. 세로는 칸 윗 모서리에 맞춰 내려오되, 화면 아래로
 *   넘치면 **넘치는 만큼 끌어올린다** — 칸 모서리에 맞추느라 반쪽 높이에 갇히지 않게(2026-11-16:
 *   일정 수정 폼이 잘려 저장 단추가 안 보였다). 화면 높이를 다 써도 모자랄 때만 안에서 스크롤.
 * - 칸 요소는 `[data-date]` 로 그릴 때마다 다시 찾는다 (달이 바뀌어 칸이 새로 그려져도 됨). 스크롤·창 크기·
 *   달력 높이(거래가 읽혀 칸이 늘어남)가 바뀌면 자리를 다시 잰다.
 * - 바깥을 누르면 닫는다. 단 **다른 날짜칸**은 칸의 onSelect 가 바꾸거나 닫으니 여기선 건드리지 않고,
 *   상자 안에서 띄운 카테고리 선택·대화상자·메뉴는 상자의 일부로 친다. Esc 도 닫음(선택기가 먼저 먹으면 제외).
 * - `document.body` 에 그린다 (CellTip 과 같은 이유: 달력의 container-type 때문에 안에서는 fixed 가 안 됨).
 */
interface Props {
  /** 붙을 칸의 날짜 (`.lg-cell[data-date]`) */
  date: string;
  onClose(): void;
  children: ReactNode;
}

const WIDTH = 420;
const GAP = 8;
const EDGE = 8;

interface Box {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * `height` 는 지금 상자의 높이(처음엔 0). 자리를 정하는 데만 쓴다 — 내용이 들어갈 자리는
 * **늘 화면 전체**(`maxHeight`)라, 높이를 다시 재도 자리만 바뀌고 높이는 안 바뀐다(되돌이 없음).
 */
function measure(date: string, height: number): Box | null {
  const cell = document.querySelector<HTMLElement>(`.lg-cell[data-date="${date}"]`);
  if (!cell) return null;
  const r = cell.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = r.right + GAP;
  if (left + WIDTH > vw - EDGE) left = r.left - GAP - WIDTH;
  if (left < EDGE) left = Math.max(EDGE, vw - EDGE - WIDTH);
  const maxHeight = Math.max(240, vh - EDGE * 2);
  // 칸 윗 모서리에서 내려오되, 아래로 넘치면 넘치는 만큼 위로 끌어올린다
  const h = Math.min(height, maxHeight);
  const top = Math.max(EDGE, Math.min(r.top, vh - EDGE - h));
  return { left, top, maxHeight };
}

export function DayPopover({ date, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);

  // 칸은 달력이 그려진 뒤에야 있으니(처음 `?date=` 로 열 때) 그린 뒤에 잰다
  useLayoutEffect(() => {
    const on = () => setBox(measure(date, ref.current?.offsetHeight ?? 0));
    on();
    const cell = document.querySelector(`.lg-cell[data-date="${date}"]`);
    const ro = new ResizeObserver(on);
    ro.observe(document.body);
    if (cell) ro.observe(cell);
    // 상자 자신도 본다 — 메모 칸이 적은 만큼 늘어나면(EventForm) 그만큼 다시 끌어올려야 한다
    if (ref.current) ro.observe(ref.current);
    const scroll = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return; // 상자 안 스크롤은 제외
      on();
    };
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", on);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", on);
    };
  }, [date]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (t instanceof Element) {
        if (t.closest(".cp-pop, .lg-dialog, .hb-menu, .hb-viewer, .lg-tip")) return;
        // 달력 줄(.lg-item)은 칸 클릭으로 안 번지고 제 상자를 띄우니 여기서 닫는다. 칸의 나머지는 onSelect 몫
        if (t.closest(".lg-cell") && !t.closest(".lg-item")) return;
      }
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return createPortal(
    <>
      {/* 뒤를 살짝 어둡게 (보기만, 클릭은 통과) — 달력 칸과 구분되게 */}
      <div className="lg-day-scrim" aria-hidden="true" />
      <div ref={ref} className="lg-day-pop" style={box ? { width: WIDTH, ...box } : { width: WIDTH, left: EDGE, top: EDGE, visibility: "hidden" }} role="dialog">
        {children}
      </div>
    </>,
    document.body,
  );
}
