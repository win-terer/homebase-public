import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

/**
 * 우클릭 메뉴.
 *
 * 브라우저 기본 메뉴는 이 사이트에서 쓸 일이 거의 없다(저장·소스 보기 등). 대신 그 자리에
 * 지금 누른 것에 맞는 일을 올린다 — 결제 한 줄에서 바로 반복 일정 만들기 같은 것.
 *
 * ## 기본 메뉴를 막는 범위
 *
 * **글자를 넣는 곳(input·textarea·contenteditable)은 건드리지 않는다.** 붙여넣기는 브라우저
 * 메뉴로만 되고, 웹페이지가 대신 해 줄 수 없다. 거기까지 막으면 쓸 수 없는 화면이 된다.
 *
 * 그 밖에는 전부 우리 메뉴가 뜬다. 어디서 눌러도 뭔가는 나오므로(최소한 뒤로·새로고침),
 * 기본 메뉴가 사라져서 못 하게 되는 일이 없다.
 *
 * ## 쓰는 쪽
 *
 * ```tsx
 * const menu = useContextMenu();
 * <li onContextMenu={(e) => menu(e, [{ label: "같은 가게 찾기", onSelect: ... }])}>
 * ```
 *
 * 컴포넌트가 먼저 잡아서 열면(React 가 document 보다 먼저 받는다) 아래의 기본 메뉴는 안 뜬다.
 */

export type MenuItem = { separator: true } | { label: string; onSelect: () => void; hint?: string; danger?: boolean; disabled?: boolean };

/**
 * 메뉴를 열 자리. 우클릭이면 그 이벤트를, **버튼으로 열 때는 좌표**를 준다
 * (설정 톱니바퀴처럼 왼쪽 클릭으로 여는 작은 메뉴 — 사용자 요청 2026-11-20).
 */
type OpenMenu = (at: MouseEvent | { x: number; y: number }, items: MenuItem[]) => void;

const MenuContext = createContext<OpenMenu>(() => {});

/** 우클릭 메뉴를 여는 함수. 이벤트와 올릴 항목을 준다. */
export function useContextMenu(): OpenMenu {
  return useContext(MenuContext);
}

const isTyping = (el: Element | null): boolean =>
  !!el?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");

interface State {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ContextMenuProvider({ children, fallback }: { children: ReactNode; fallback?: () => MenuItem[] }) {
  const [state, setState] = useState<State | null>(null);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setState(null), []);

  const open = useCallback<OpenMenu>((at, items) => {
    if (!items.length) return;
    if ("clientX" in at) {
      // 행 안에 메모 입력칸이 있다 — 거기서는 브라우저 메뉴를 그대로 둬야 붙여넣기가 된다.
      // 쓰는 쪽마다 챙기게 하면 언젠가 빠뜨리므로 여기서 한 번에 막는다
      if (isTyping(at.target as Element | null)) return;
      at.preventDefault();
      at.stopPropagation();
      setState({ x: at.clientX, y: at.clientY, items });
    } else {
      setState({ x: at.x, y: at.y, items });
    }
    setActive(-1);
  }, []);

  // 아무 컴포넌트도 안 잡은 우클릭: 기본 메뉴를 막고 공통 메뉴를 올린다
  useEffect(() => {
    const onContext = (e: globalThis.MouseEvent) => {
      if (e.defaultPrevented) return; // 어떤 행이 이미 자기 메뉴를 열었다
      if (isTyping(e.target as Element | null)) return; // 붙여넣기는 브라우저 것만 할 수 있다
      const items = fallback?.() ?? [];
      if (!items.length) return;
      e.preventDefault();
      setState({ x: e.clientX, y: e.clientY, items });
      setActive(-1);
    };
    document.addEventListener("contextmenu", onContext);
    return () => document.removeEventListener("contextmenu", onContext);
  }, [fallback]);

  // 화면 밖으로 나가지 않게 (커서 기준으로 띄우되, 모서리에서는 안쪽으로 접는다)
  useLayoutEffect(() => {
    const el = box.current;
    if (!state || !el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    const x = Math.max(pad, Math.min(state.x, window.innerWidth - width - pad));
    const y = Math.max(pad, Math.min(state.y, window.innerHeight - height - pad));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.focus();
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) close();
    };
    // 스크롤하면 메뉴만 제자리에 남아 엉뚱한 곳을 가리킨다 — 그냥 닫는다
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("contextmenu", onDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("contextmenu", onDown);
    };
  }, [state, close]);

  const pick = (item: MenuItem) => {
    if ("separator" in item || item.disabled) return;
    close();
    item.onSelect();
  };

  const step = (dir: 1 | -1) => {
    if (!state) return;
    const n = state.items.length;
    let i = active;
    for (let tries = 0; tries < n; tries++) {
      i = (i + dir + n) % n;
      const item = state.items[i]!;
      if (!("separator" in item) && !item.disabled) {
        setActive(i);
        return;
      }
    }
  };

  return (
    <MenuContext.Provider value={open}>
      {children}
      {state && (
        <div
          ref={box}
          className="hb-menu"
          role="menu"
          tabIndex={-1}
          aria-label="바로가기 메뉴"
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") step(1);
            else if (e.key === "ArrowUp") step(-1);
            else if (e.key === "Enter" || e.key === " ") {
              const item = state.items[active];
              if (item) pick(item);
            } else return;
            e.preventDefault();
          }}
        >
          {state.items.map((item, i) =>
            "separator" in item ? (
              <hr key={`sep-${i}`} className="hb-menu-sep" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`hb-menu-item ${item.danger ? "is-danger" : ""} ${i === active ? "is-active" : ""}`}
                disabled={item.disabled}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(item)}
              >
                <span>{item.label}</span>
                {item.hint && <span className="hb-menu-hint">{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </MenuContext.Provider>
  );
}
