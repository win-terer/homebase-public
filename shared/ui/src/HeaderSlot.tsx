/**
 * 헤더 오른쪽 한 칸을 **화면 쪽에서** 채워 넣는 통로.
 *
 * 접속 표시('○○ 보는 중')는 달력이 들고 있는 값인데 자리는 헤더다(사용자 요청 2026-11-20).
 * 그 값을 AppShell 까지 끌어올리면 껍데기가 달력을 알게 되고, 달력을 안 쓰는 화면에도
 * 빈 자리가 생긴다. 그래서 **자리만 껍데기가 내주고, 넣는 건 화면이** 한다.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const HEADER_SLOT_ID = "hb-header-slot";

export function HeaderSlot({ children }: { children: ReactNode }) {
  // 그릴 때는 아직 DOM 에 붙기 전이라 자리를 못 찾는다 — 붙고 나서 한 번 더 그린다
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.getElementById(HEADER_SLOT_ID)), []);
  return el ? createPortal(children, el) : null;
}
