import type { ImportDecision, NormalizedTransaction } from "./types.ts";

/**
 * 뱅크샐러드 거래를 가져올지에 대한 기본 판단 (서버에서 실행).
 * 이체는 사용자 규칙(ledger_transfer_rules)이 이 판단보다 우선한다.
 */

/**
 * 이체 대분류별 기본 처리.
 * 뱅크샐러드의 '저축'·'투자'·'현금' 분류는 믿을 수 없다 (급여가 저축으로, 헬스장·보험·인테리어
 * 이체가 현금으로 오는 등). 그래서 확실한 두 분류만 자동 처리하고, 나머지는 이름 규칙에 걸리지
 * 않으면 사용자 확인으로 보낸다.
 */
const TRANSFER_EXCLUDED = new Set(["내계좌이체", "카드대금"]);
const TRANSFER_INCLUDED = new Set(["이체"]);

/** 거래로 보지 않는 항목 (내용 기준, 모든 타입). 실제 내보내기에서 확인한 이름만 넣는다 */
const EXCLUDED_MERCHANTS: Record<string, string> = {
  // 뱅크샐러드가 계좌 잔액을 맞추려고 만드는 보정 항목 (타입: 이체)
  차액: "잔액 차액 보정",
  // ATM 현금 인출이 '지출'로 분류되어 오는 경우. 현금 지출은 사용자가 직접 입력한다
  CD현금지급: "현금 인출",
  // 내 예금을 해지해서 들어온 돈인데 '수입'으로 온다
  "예금 해지": "내 저축",
};

/** 이체 중 내 돈 이동으로 보는 이름. 분류와 상관없이 제외한다 */
const OWN_MONEY_TRANSFERS: Record<string, string> = {
  "연결계좌로 빼기": "내 계좌 이동",
  "플러스박스로 더하기": "내 계좌 이동",
  "플러스박스(세이브박스)": "내 계좌 이동",
  "적금 자동이체": "내 저축",
  "적금 입금": "내 저축",
  "적금 해지": "내 저축",
  // 카드값 출금이 '현금'으로 분류되어 오는 경우
  현대카드: "카드대금",
};

export function classifyBanksalad(tx: NormalizedTransaction): { decision: ImportDecision; reason: string } {
  const excluded = EXCLUDED_MERCHANTS[tx.merchant];
  if (excluded) return { decision: "exclude", reason: excluded };
  if (tx.kind !== "transfer") return { decision: "include", reason: tx.kind };

  const own = OWN_MONEY_TRANSFERS[tx.merchant];
  if (own) return { decision: "exclude", reason: own };
  const major = tx.sourceCategory?.major ?? "";
  if (TRANSFER_EXCLUDED.has(major)) return { decision: "exclude", reason: major };
  if (TRANSFER_INCLUDED.has(major)) return { decision: "include", reason: major };
  return { decision: "review", reason: major || "분류 없음" };
}
