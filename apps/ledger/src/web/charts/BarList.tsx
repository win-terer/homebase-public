export interface BarRow {
  label: string;
  /** 막대 길이 0~1 */
  ratio: number;
  value: string;
  sub?: string;
  /** 금액 가리기 대상 (수입 등) */
  secret?: boolean;
}

/** 순위 목록 + 가로 막대 (한 가지 색). 값은 막대 옆 글자로 표시한다 */
export function BarList({
  rows,
  empty = "기록이 없어요.",
  onSelect,
  selected,
  ranked = true,
}: {
  rows: BarRow[];
  empty?: string;
  /** 줄을 누르면 (상세 보기) */
  onSelect?(index: number): void;
  /** 고른 줄 (강조) */
  selected?: string | null;
  /** 앞에 순위 번호 */
  ranked?: boolean;
}) {
  if (!rows.length) return <p className="hb-muted">{empty}</p>;
  return (
    <ol className="st-barlist">
      {rows.map((r, i) => (
        <li
          key={r.label}
          className={`${onSelect ? "is-clickable" : ""} ${selected === r.label ? "is-selected" : ""}`}
          onClick={() => onSelect?.(i)}
          onKeyDown={(e) => {
            if (onSelect && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              onSelect(i);
            }
          }}
          tabIndex={onSelect ? 0 : undefined}
          role={onSelect ? "button" : undefined}
        >
          {ranked && <span className="st-rank">{i + 1}</span>}
          <div className="st-barlist-main">
            <div className="st-barlist-text">
              <span className="st-barlist-label" title={r.label}>
                {r.label}
              </span>
              <span className={`st-barlist-value ${r.secret ? "hb-secret" : ""}`}>{r.value}</span>
            </div>
            <div className="st-track">
              <div className="st-fill" style={{ width: `${Math.max(1, r.ratio * 100)}%` }} />
            </div>
            {r.sub && <div className="st-barlist-sub">{r.sub}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
