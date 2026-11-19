import { useState } from "react";

interface Props {
  rows: string[];
  cols: string[];
  /** grid[row][col] */
  values: { count: number; spend: number }[][];
  format(cell: { count: number; spend: number }, row: string, col: string): string;
  /** 칸 안에 연하게 쓸 글자 (위: 큰 숫자, 아래: 작은 괄호). 빈 칸은 부르지 않는다 */
  label?(cell: { count: number; spend: number }): { main: string; sub?: string };
  /** 칸을 누르면 (상세 보기). 빈 칸은 부르지 않는다 */
  onSelect?(row: number, col: number): void;
}

const STEPS = 5;

/** 요일 × 시간대 히트맵. 한 가지 색의 5단계 (많을수록 진하게) */
export function Heatmap({ rows, cols, values, format, label, onSelect }: Props) {
  const [hover, setHover] = useState<[number, number] | null>(null);
  const max = Math.max(0, ...values.flat().map((c) => c.count));
  const step = (n: number) => (n === 0 || max === 0 ? 0 : Math.min(STEPS, Math.ceil((n / max) * STEPS)));
  const caption = hover ? format(values[hover[0]]![hover[1]]!, rows[hover[0]]!, cols[hover[1]]!) : onSelect ? "칸에 마우스를 올리면 요약, 누르면 그 칸의 결제 목록이 보여요." : "칸에 마우스를 올리면 자세히 보여요.";

  return (
    <div className="st-heat" onMouseLeave={() => setHover(null)}>
      <div className="st-heat-grid" style={{ gridTemplateColumns: `2.2em repeat(${cols.length}, minmax(0, 1fr))` }}>
        <span />
        {cols.map((c) => (
          <span key={c} className="st-heat-col">
            {c}
          </span>
        ))}
        {rows.map((r, ri) => (
          <div key={r} className="st-heat-row" style={{ display: "contents" }}>
            <span className="st-heat-rowlabel">{r}</span>
            {cols.map((c, ci) => {
              const cell = values[ri]![ci]!;
              const text = label && cell.count > 0 ? label(cell) : null;
              return (
                <span
                  key={c}
                  className={`st-heat-cell step-${step(cell.count)} ${hover?.[0] === ri && hover?.[1] === ci ? "is-hover" : ""} ${onSelect && cell.count ? "is-clickable" : ""}`}
                  onMouseEnter={() => setHover([ri, ci])}
                  onFocus={() => setHover([ri, ci])}
                  onClick={() => cell.count && onSelect?.(ri, ci)}
                  onKeyDown={(e) => {
                    if (onSelect && cell.count && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      onSelect(ri, ci);
                    }
                  }}
                  tabIndex={0}
                  aria-label={format(cell, r, c)}
                >
                  {text && (
                    <span className="st-heat-text" aria-hidden="true">
                      <span>{text.main}</span>
                      {text.sub && <span className="st-heat-sub">{text.sub}</span>}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <div className="st-heat-foot">
        <span className="st-heat-caption">{caption}</span>
        <span className="st-heat-legend">
          적음
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} className={`st-heat-cell step-${i + 1}`} />
          ))}
          많음
        </span>
      </div>
    </div>
  );
}
