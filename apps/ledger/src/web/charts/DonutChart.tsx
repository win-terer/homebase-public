import { useState } from "react";

export interface Slice {
  label: string;
  value: number;
  /** CSS 색 (변수 권장) */
  color: string;
  /** 범례 둘째 줄 */
  sub?: string;
}

interface Props {
  slices: Slice[];
  formatValue(n: number): string;
  centerLabel: string;
  /** 조각·범례를 누르면 (상세 보기) */
  onSelect?(index: number): void;
}

const SIZE = 220;
const R_OUT = 104;
const R_IN = 70;
const GAP = 2; // 조각 사이 표면색 간격(px)

function arc(start: number, end: number): string {
  const c = SIZE / 2;
  const padOut = GAP / 2 / R_OUT;
  const padIn = GAP / 2 / R_IN;
  const a0 = start + padOut, a1 = end - padOut;
  const b0 = start + padIn, b1 = end - padIn;
  if (a1 <= a0) return "";
  const pt = (r: number, a: number) => `${c + r * Math.sin(a)},${c - r * Math.cos(a)}`;
  const large = end - start > Math.PI ? 1 : 0;
  return [
    `M${pt(R_OUT, a0)}`,
    `A${R_OUT},${R_OUT} 0 ${large} 1 ${pt(R_OUT, a1)}`,
    `L${pt(R_IN, b1)}`,
    `A${R_IN},${R_IN} 0 ${large} 0 ${pt(R_IN, b0)}`,
    "Z",
  ].join(" ");
}

/** 비중을 한눈에 보는 도넛 + 범례. 조각은 6개 이하로 넘긴다 (나머지는 '기타') */
export function DonutChart({ slices, formatValue, centerLabel, onSelect }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!total) return <p className="hb-muted">기록이 없어요.</p>;

  let angle = 0;
  const paths = slices.map((s) => {
    const start = angle;
    angle += (s.value / total) * Math.PI * 2;
    // 조각이 하나뿐이면 원 전체를 두 번에 나눠 그린다
    return slices.length === 1 ? `${arc(0, Math.PI)} ${arc(Math.PI, Math.PI * 2)}` : arc(start, angle);
  });
  const focus = hover === null ? null : slices[hover]!;

  return (
    <div className="st-donut" onMouseLeave={() => setHover(null)}>
      <div className="st-donut-figure">
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="카테고리별 지출 비중">
          {slices.map((s, i) => (
            <path
              key={s.label}
              d={paths[i]}
              fill={s.color}
              className={`${hover !== null && hover !== i ? "is-dim" : ""} ${onSelect ? "is-clickable" : ""}`}
              onMouseEnter={() => setHover(i)}
              onClick={() => onSelect?.(i)}
            />
          ))}
        </svg>
        <div className="st-donut-center">
          <span className="st-donut-center-label">{focus ? focus.label : centerLabel}</span>
          <strong className="hb-secret">{formatValue(focus ? focus.value : total)}</strong>
          {focus && <span className="st-donut-center-sub">{Math.round((focus.value / total) * 100)}%</span>}
        </div>
      </div>
      <ul className="st-legend">
        {slices.map((s, i) => (
          <li
            key={s.label}
            className={`${hover === i ? "is-active" : ""} ${onSelect ? "is-clickable" : ""}`}
            onMouseEnter={() => setHover(i)}
            tabIndex={0}
            onFocus={() => setHover(i)}
            onClick={() => onSelect?.(i)}
            onKeyDown={(e) => {
              if (onSelect && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onSelect(i);
              }
            }}
            role={onSelect ? "button" : undefined}
          >
            <span className="st-swatch" style={{ background: s.color }} aria-hidden="true" />
            <span className="st-legend-label">{s.label}</span>
            <span className="st-legend-pct">{Math.round((s.value / total) * 100)}%</span>
            <span className="st-legend-value">{formatValue(s.value)}</span>
            {s.sub && <span className="st-legend-sub">{s.sub}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
