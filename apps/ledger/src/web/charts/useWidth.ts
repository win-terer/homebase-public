import { useLayoutEffect, useRef, useState } from "react";

/** 요소의 실제 너비. SVG 를 viewBox 로 늘리지 않고 픽셀 단위로 그려 글자가 뭉개지지 않게 한다 */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}
