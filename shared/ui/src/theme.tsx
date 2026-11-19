import { useEffect, useState } from "react";
import { THEME_KEY as KEY } from "./theme-boot.ts";

/**
 * 화면 밝기: 자동(기기 설정) / 밝게 / 어둡게. 기기(브라우저)마다 기억한다.
 * 실제로 칠할 색은 <html data-theme="light|dark"> 로 정하고, CSS 는 `:root[data-theme="dark"]` 로 어두운 색을 쓴다.
 * 첫 화면이 깜빡이지 않게 index.html·로그인 화면의 작은 스크립트가 같은 규칙으로 먼저 정해 둔다 (theme-boot.ts).
 */
export type ThemeMode = "auto" | "light" | "dark";

const ORDER: ThemeMode[] = ["auto", "light", "dark"];
const LABEL: Record<ThemeMode, string> = { auto: "자동", light: "밝게", dark: "어둡게" };

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

const systemDark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;

function apply(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode === "auto" ? (systemDark() ? "dark" : "light") : mode;
}

export function ThemeToggle() {
  const [mode, setMode] = useState(readMode);

  useEffect(() => {
    apply(mode);
    try {
      if (mode === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, mode);
    } catch {
      // 저장이 막힌 브라우저에서도 동작은 한다
    }
    if (mode !== "auto") return;
    // 자동이면 기기 설정이 바뀔 때 따라간다 (해 질 때 자동 전환 등)
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => apply("auto");
    mq?.addEventListener("change", onChange);
    return () => mq?.removeEventListener("change", onChange);
  }, [mode]);

  const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]!;
  return (
    <button
      type="button"
      className="hb-theme"
      title={`화면: ${LABEL[mode]}. 누르면 ${LABEL[next]}`}
      aria-label={`화면 밝기 ${LABEL[mode]}, 누르면 ${LABEL[next]}`}
      onClick={() => setMode(next)}
    >
      <ThemeIcon mode={mode} />
      <span className="hb-theme-label">{LABEL[mode]}</span>
    </button>
  );
}

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (mode === "light")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  if (mode === "dark")
    return (
      <svg {...common}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  // 자동: 반쪽 원
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
    </svg>
  );
}
