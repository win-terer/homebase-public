import { useState } from "react";
import { useWidth } from "./useWidth.ts";

export interface Column {
  key: string;
  label: string;
  value: number;
  /** 툴팁 제목과 줄들 */
  title: string;
  lines: string[];
}

interface Props {
  data: Column[];
  height?: number;
  /** 평균선 (없으면 생략) */
  average?: { value: number; label: string };
  formatTick(n: number): string;
  /** x축 이름을 몇 개마다 보일지 (0 이면 자동) */
  labelEvery?: number;
  /** 이 막대만 강조하고 나머지는 회색으로 (기간 비교용) */
  highlightKey?: string;
  ariaLabel?: string;
  /** 막대를 누르면 (상세 보기·기간 이동) */
  onSelect?(index: number): void;
}

const PAD = { top: 20, right: 16, bottom: 28, left: 52 };
const MAX_BAR = 24;

/** 4개 안팎의 깔끔한 눈금 (1·2·2.5·5 × 10^n) */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1]! < max) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

/** 위쪽만 둥근 막대 (바닥은 직각) */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function ColumnChart({ data, height = 260, average, formatTick, labelEvery = 0, highlightKey, ariaLabel = "기간별 지출 막대 그래프", onSelect }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const values = data.map((d) => Math.max(0, d.value));
  const ticks = niceTicks(Math.max(...values, average?.value ?? 0));
  const top = ticks[ticks.length - 1]!;
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  const band = data.length ? innerW / data.length : 0;
  const barW = Math.max(2, Math.min(MAX_BAR, band - 2, band * 0.64));
  const y = (v: number) => PAD.top + innerH - (top ? (v / top) * innerH : 0);
  const every = labelEvery || Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(innerW / 44))));
  const hovered = hover === null ? null : data[hover];

  return (
    <div ref={ref} className="st-chart" style={{ height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="st-grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="st-tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {formatTick(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const v = values[i]!;
            const x = PAD.left + band * i + (band - barW) / 2;
            const h = y(0) - y(v);
            return (
              <g key={d.key}>
                {highlightKey === d.key && v > 0 && (
                  <text className="st-cap-label" x={x + barW / 2} y={y(v) - 6} textAnchor="middle">
                    {formatTick(v)}
                  </text>
                )}
                {h > 0 && (
                  <path
                    className={`st-bar ${hover === i ? "is-hover" : ""} ${highlightKey && d.key !== highlightKey ? "is-muted" : ""}`}
                    d={barPath(x, y(v), barW, h)}
                  />
                )}
                {(i % every === 0 || data.length <= 12) && (
                  <text className="st-xlabel" x={PAD.left + band * i + band / 2} y={height - 8} textAnchor="middle">
                    {d.label}
                  </text>
                )}
                {/* 막대보다 넓은 마우스 영역 */}
                <rect
                  x={PAD.left + band * i}
                  y={PAD.top}
                  width={band}
                  height={innerH}
                  fill="transparent"
                  className={onSelect ? "is-clickable" : undefined}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onClick={() => onSelect?.(i)}
                  onKeyDown={(e) => {
                    if (onSelect && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onSelect(i);
                    }
                  }}
                  tabIndex={0}
                  aria-label={`${d.title} ${d.lines.join(", ")}`}
                />
              </g>
            );
          })}
          {average && average.value > 0 && (
            <g>
              <line className="st-avg" x1={PAD.left} x2={width - PAD.right} y1={y(average.value)} y2={y(average.value)} />
              <text className="st-avg-label" x={width - PAD.right} y={y(average.value) - 6} textAnchor="end">
                {average.label}
              </text>
            </g>
          )}
        </svg>
      )}
      {hovered && hover !== null && (
        <div
          className="st-tooltip"
          style={{
            left: Math.min(Math.max(PAD.left + band * hover + band / 2, 90), width - 90),
            top: Math.max(4, y(values[hover]!) - 12),
          }}
        >
          <strong>{hovered.title}</strong>
          {hovered.lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}
