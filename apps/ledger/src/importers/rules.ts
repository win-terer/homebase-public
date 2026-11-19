import { classifyBanksalad } from "./banksalad-rules.ts";
import type { ImportDecision, NormalizedTransaction } from "./types.ts";

export type Classifier = (tx: NormalizedTransaction) => { decision: ImportDecision; reason: string };

/** 소스별 기본 판단 (서버). 엑셀 라이브러리를 끌어오지 않도록 파일 읽기와 따로 둔다 */
export const importSources: Record<string, { label: string; classify: Classifier }> = {
  "banksalad-xlsx": { label: "뱅크샐러드 내보내기 (xlsx)", classify: classifyBanksalad },
};
