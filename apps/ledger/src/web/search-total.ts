import { flowOf, type Transaction } from "./api.ts";
import { formatMonth } from "./dates.ts";

/**
 * 검색 결과의 합계와 **기간별 합계** (2026-11-18 사용자 요청: "검색한 거 합계 같은 것도
 * 기간별 합계 같은 것도 가볍게 나오면 좋겠어").
 *
 * **서버에 더 묻지 않는다** — 이미 받아 온 줄들로만 센다. 검색은 `LIKE '%…%'` 라 표를 통째로
 * 한 번 훑는데(7,000건 ≈ 7천 행), 합계 쿼리를 따로 보내면 그 훑기가 한 번 더 돈다. 그래서
 * 화면이 들고 있는 것으로만 계산하고, 200건을 넘겨 잘린 검색에서는 "받아 온 데까지" 라고 밝힌다.
 *
 * 취소된 짝은 부르는 쪽이 `countedRows` 로 미리 걷어낸다 (결제·환불 **둘 다** 뺀다).
 */
export type SumUnit = "month" | "year";

export interface PeriodSum {
  /** "2026-11" 또는 "2026" */
  key: string;
  label: string;
  count: number;
  /** 나간 돈 (지출 + 보낸 이체, 환불로 상쇄) */
  out: number;
  /** 들어온 돈 (수입 + 받은 이체) */
  in: number;
}

/** 달별(또는 해별) 합계. 최근 것부터 */
export function periodSums(txs: Transaction[], unit: SumUnit): PeriodSum[] {
  const cut = unit === "month" ? 7 : 4;
  const by = new Map<string, Transaction[]>();
  for (const t of txs) {
    const key = t.date.slice(0, cut);
    const list = by.get(key);
    if (list) list.push(t);
    else by.set(key, [t]);
  }
  return [...by.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, list]) => {
      const flow = flowOf(list);
      return { key, label: unit === "month" ? formatMonth(key) : `${key}년`, count: list.length, out: flow.out, in: flow.in };
    });
}

/**
 * 처음에 보여줄 단위. 달이 15개를 넘어가면 줄이 너무 길어져 해별로 묶는다
 * (2년 치 매달 결제가 24줄이면 표가 결과 목록보다 길어진다).
 */
export function defaultUnit(txs: Transaction[]): SumUnit {
  return new Set(txs.map((t) => t.date.slice(0, 7))).size > 15 ? "year" : "month";
}
