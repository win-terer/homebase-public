/**
 * 확인 필요한 이체의 추천 처리. 상대방 이름의 일반적인 말(보험·대출·보증금·적금 등)만 보고 정한다.
 * 사람 이름으로 된 이체는 추측하지 않는다. 사용자가 화면에서 확인하고 적용한다.
 */
import type { RuleAction } from "./api.ts";

export interface ReviewSuggestion {
  action: RuleAction;
  /** 지출·수입일 때 "대분류" 또는 "대분류 > 소분류" */
  category?: string;
  /** 왜 이렇게 추천했는지 (화면 표시용) */
  reason: string;
}

type Rule = { pattern: RegExp; direction: "out" | "in" | "any"; suggestion: ReviewSuggestion };

const RULES: Rule[] = [
  // 내 돈 이동·확인용 소액
  { pattern: /적금|예금|청약|세이브|파킹/, direction: "any", suggestion: { action: "exclude", reason: "내 저축" } },
  { pattern: /계좌인증|본인인증/, direction: "any", suggestion: { action: "exclude", reason: "계좌 확인용 소액" } },
  // 나가는 돈
  { pattern: /생명|화재|손해보험|보험/, direction: "out", suggestion: { action: "expense", category: "보험", reason: "보험료" } },
  { pattern: /주택금융공사|대출|보금자리/, direction: "out", suggestion: { action: "expense", category: "주거 > 대출 이자", reason: "대출 상환" } },
  { pattern: /인테리어|인테$/, direction: "out", suggestion: { action: "expense", category: "주거 > 인테리어", reason: "인테리어" } },
  { pattern: /이사|이삿짐|익스프레스/, direction: "out", suggestion: { action: "expense", category: "주거 > 이사", reason: "이사" } },
  { pattern: /관리비/, direction: "out", suggestion: { action: "expense", category: "주거 > 관리비", reason: "관리비" } },
  { pattern: /헬스케|렌탈|렌털/, direction: "out", suggestion: { action: "expense", category: "의료/건강 > 의료기기", reason: "렌탈" } },
  { pattern: /헬스|피트니스|필라테스|PT/, direction: "out", suggestion: { action: "expense", category: "의료/건강 > 운동", reason: "운동" } },
  { pattern: /지방소득|국세|세무서|구청|시청/, direction: "out", suggestion: { action: "expense", category: "세금/수수료", reason: "세금" } },
  // 들어오는 돈
  { pattern: /보증금/, direction: "in", suggestion: { action: "transfer", reason: "보증금 반환 (내 돈이 돌아온 것)" } },
  { pattern: /급여|상여|연말정산|퇴직/, direction: "in", suggestion: { action: "income", category: "급여", reason: "급여" } },
  { pattern: /결산|이자/, direction: "in", suggestion: { action: "income", category: "금융수입 > 이자", reason: "이자" } },
  { pattern: /캐시백|리워드|보상금|포인트|바우처/, direction: "in", suggestion: { action: "income", category: "금융수입 > 캐시백/리워드", reason: "캐시백·리워드" } },
  { pattern: /지방소득|국세|환급/, direction: "in", suggestion: { action: "income", category: "기타", reason: "세금 환급" } },
];

/** 추천이 없으면 null. total 은 그 상대방 이체 합계 (나간 돈 음수) */
export function suggestReview(counterparty: string, total: number): ReviewSuggestion | null {
  const direction = total < 0 ? "out" : "in";
  const rule = RULES.find((r) => (r.direction === "any" || r.direction === direction) && r.pattern.test(counterparty));
  if (rule) return rule.suggestion;
  // 이름으로 모르는 1~10원: 계좌·카드 연결할 때 들어오는 확인용 입금
  if (Math.abs(total) <= 10) return { action: "exclude", reason: "계좌 확인용 소액" };
  return null;
}

export interface ActionChoice {
  value: RuleAction;
  label: string;
  hint: string;
}

/**
 * 금액 부호에 맞는 처리만 고르게 한다.
 * - 나간 돈만: 지출 / 이체로 기록 / 제외 (나간 돈을 수입으로 잡을 수 없음)
 * - 들어온 돈만: 수입 / 환불 / 이체로 기록 / 제외. 환불은 지출 카테고리에서 빼는 것 (부분환불·취소 등)
 * - 섞여 있으면 네 가지 모두
 */
export function actionsFor(amounts: number[]): ActionChoice[] {
  const incoming = amounts.length > 0 && amounts.every((a) => a > 0);
  const outgoing = amounts.length > 0 && amounts.every((a) => a < 0);
  const transfer: ActionChoice = { value: "transfer", label: "이체로 기록", hint: "달력에 남기고 지출·수입 통계에는 넣지 않음" };
  const exclude: ActionChoice = { value: "exclude", label: "제외", hint: "내 돈 이동 등. 저장하지 않음" };
  const expense: ActionChoice = { value: "expense", label: "지출", hint: "통계에 지출로 (보험료·대출 상환·렌탈 등)" };
  const income: ActionChoice = { value: "income", label: "수입", hint: "통계에 수입으로 (급여·환급 등)" };
  if (outgoing) return [expense, transfer, exclude];
  if (incoming) return [income, { value: "expense", label: "환불", hint: "지출에서 빼기 (부분환불·결제 취소 등). 지출 카테고리를 골라요" }, transfer, exclude];
  return [expense, income, transfer, exclude];
}
