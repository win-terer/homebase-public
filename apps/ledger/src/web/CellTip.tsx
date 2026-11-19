import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * 달력 칸 줄의 설명 상자 (브라우저 `title` 대신). **올리면 보기, 누르면 고정**.
 *
 * - 올리면: 줄에서 숨긴 것(정확한 시각·원래 가게·전체 금액·카드·분류·상세 메모)을 보여준다.
 *   `title` 을 안 쓰는 이유: 뜨기까지 1초 가까이 걸리고, 줄바꿈·색을 못 넣고, 글꼴도 못 맞춘다.
 * - 누르면: 그 자리에 고정되고 안에서 메모·분류를 고친다(`renderPinned`). 날짜 상세까지 안 가고
 *   줄 한 번 눌러 메모를 다는 게 목적이다. 바깥을 누르거나 Esc 로 닫는다.
 *
 * `document.body` 에 그린다 — 달력(`.lg-grid`)은 컨테이너 쿼리 때문에 `container-type` 이 붙어
 * 있어 안에서는 `position: fixed` 가 화면이 아니라 달력 기준이 된다. 자리는 그릴 때마다 줄 요소의
 * 위치를 다시 재서, 스크롤해도 줄을 따라간다.
 */
export interface TipContent {
  title: string;
  /** 제목 옆 작은 꼬리표 (앱·취소함·예정) */
  tags?: string[];
  /** 한 줄씩. null 은 건너뜀 */
  lines: (ReactNode | null)[];
  /** 상세 메모 (여러 줄) */
  note?: string | null;
}

const HOVER_WIDTH = 280;
const PIN_WIDTH = 400;

/** 올린 줄 아래에 붙인다. 아래가 모자라면 위로, 오른쪽이 모자라면 왼쪽으로 민다 */
function place(
  rect: DOMRect,
  width: number,
  height: number,
): { left: number; top?: number; bottom?: number } {
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 6;
  if (
    below + height > window.innerHeight &&
    rect.top > window.innerHeight / 2
  ) {
    return { left, bottom: window.innerHeight - rect.top + 6 };
  }
  return { left, top: below };
}

interface Hover {
  el: HTMLElement;
  content: TipContent;
}

interface Pin<K> {
  el: HTMLElement;
  key: K;
}

/**
 * @param renderPinned 고정했을 때 안에 그릴 것. null 을 돌려주면(그 줄이 사라졌으면) 닫는다.
 * @param sameKey 두 키가 같은 줄인지 (다시 누르면 닫기 위해)
 */
export function useCellTip<K>(
  renderPinned?: (key: K) => ReactNode | null,
  sameKey: (a: K, b: K) => boolean = Object.is,
) {
  const [hover, setHover] = useState<Hover | null>(null);
  const [pin, setPin] = useState<Pin<K> | null>(null);
  const [, bump] = useState(0);
  const popRef = useRef<HTMLDivElement>(null);

  // 스크롤·창 크기 변경이면 자리를 다시 잰다 (상자 안의 목록 스크롤은 제외)
  useEffect(() => {
    if (!hover && !pin) return;
    const on = (e: Event) => {
      if (e.target instanceof Node && popRef.current?.contains(e.target))
        return;
      bump((n) => n + 1);
    };
    window.addEventListener("scroll", on, true);
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on, true);
      window.removeEventListener("resize", on);
    };
  }, [hover, pin]);

  // 고정 상자: 바깥 누르면 닫기(그 줄 자체를 다시 누르는 건 onClick 이 토글), Esc 로 닫기
  useEffect(() => {
    if (!pin) return;
    const down = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || pin.el.contains(t)) return;
      // 상자 안에서 띄운 카테고리 선택·대화상자도 상자의 일부다
      if (t instanceof Element && t.closest(".cp-pop, .lg-dialog, .hb-menu, .hb-viewer"))
        return;
      setPin(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setPin(null);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [pin]);

  const bind = (content: TipContent, pinKey?: K) => ({
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      if (!pin) setHover({ el: e.currentTarget, content });
    },
    onMouseLeave: () => setHover(null),
    onClick:
      pinKey === undefined || !renderPinned
        ? undefined
        : (e: MouseEvent<HTMLElement>) => {
            e.stopPropagation(); // 칸 선택(날짜 상세)까지 번지지 않게
            const el = e.currentTarget; // 갱신 함수가 돌 때는 currentTarget 이 이미 null 이다
            setHover(null);
            setPin((p) => (p && sameKey(p.key, pinKey) ? null : { el, key: pinKey }));
          },
  });

  let tip: ReactNode = null;
  if (pin && renderPinned) {
    const inner = renderPinned(pin.key);
    if (inner === null) {
      // 그 줄이 사라졌다 (달을 옮김·다시 읽음). 렌더 중에 상태를 바꾸지 않고 다음 틱에 닫는다
      queueMicrotask(() => setPin((p) => (p === pin ? null : p)));
    } else {
      tip = createPortal(
        <div
          ref={popRef}
          className="lg-tip is-pinned"
          style={{
            width: PIN_WIDTH,
            ...place(pin.el.getBoundingClientRect(), PIN_WIDTH, 260),
          }}
          role="dialog"
        >
          <button
            type="button"
            className="lg-tip-close"
            onClick={() => setPin(null)}
            aria-label="닫기"
          >
            ✕
          </button>
          {inner}
        </div>,
        document.body,
      );
    }
  } else if (hover) {
    const { content } = hover;
    tip = createPortal(
      <div
        ref={popRef}
        className="lg-tip"
        style={{
          width: HOVER_WIDTH,
          ...place(hover.el.getBoundingClientRect(), HOVER_WIDTH, 180),
        }}
        role="tooltip"
      >
        <div className="lg-tip-title">
          <span>{content.title}</span>
          {content.tags?.map((t) => (
            <span key={t} className="lg-tip-tag">
              {t}
            </span>
          ))}
        </div>
        {content.lines
          .filter((l) => l !== null && l !== undefined && l !== "")
          .map((l, i) => (
            <div key={i} className="lg-tip-line">
              {l}
            </div>
          ))}
        {content.note && <div className="lg-tip-note">{content.note}</div>}
      </div>,
      document.body,
    );
  }

  return { bind, tip, pinned: pin !== null, closePin: () => setPin(null) };
}
