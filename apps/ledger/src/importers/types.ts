import type { Snapshot } from "./banksalad-snapshot.ts";

/**
 * 가져오기(import) 소스 계약.
 *
 * 소스(뱅크샐러드 엑셀 등)마다 파일 읽기(ImportParser, 브라우저)와 기본 판단(서버, rules.ts)을 하나씩 두고 등록한다.
 * 실제 파일 형식은 사용자가 준 파일을 보고 구현한다 — 추측해서 만들지 않는다.
 */

export interface ImportFile {
  name: string;
  bytes: Uint8Array;
}

export interface ParseOptions {
  /** 비밀번호 걸린 엑셀용. 파싱에만 쓰고 저장하지 않는다. */
  password?: string;
}

export type TransactionKind = "expense" | "income" | "transfer";

/** 소스와 무관하게 통일된 형태의 거래 1건 */
export interface NormalizedTransaction {
  kind: TransactionKind;
  /** 로컬(Asia/Seoul) 날짜 "YYYY-MM-DD" */
  date: string;
  /** 로컬 시각 "HH:mm:ss". 소스에 시각이 없으면 null */
  time: string | null;
  /** 가맹점 또는 이체 상대방 */
  merchant: string;
  /** 원 단위 정수. 나간 돈은 음수, 들어온 돈은 양수 (취소·환불은 양수 지출) */
  amount: number;
  /** 결제 수단 이름. 예: "○○카드 Edition3(할인형)" */
  paymentMethod: string;
  /** 소스가 제공하는 승인번호 등 고유 식별자 (있으면 중복 제거에 우선 사용) */
  externalId?: string;
  /** 소스가 제공하는 카테고리 */
  sourceCategory?: { major: string; minor?: string };
  memo?: string;
  /**
   * 브라우저가 파일 전체를 보고 미리 정한 제외 사유 (지금은 `간편결제 중복` 하나).
   * 서버는 500건씩 나눠 받기 때문에 **파일 전체를 한눈에 보는 건 브라우저뿐**이다 —
   * 짝이 다른 조각에 있으면 서버에서는 영영 못 찾는다.
   */
  excludeReason?: string;
}

export interface ParseResult {
  transactions: NormalizedTransaction[];
  /** 해석하지 못한 행. 사용자에게 보여주고 건너뛴다 */
  skipped: { row: string; reason: string }[];
}

export type ImportDecision = "include" | "exclude" | "review";

/** 파일을 읽어 거래로 바꾸는 쪽 (브라우저에서 실행. 원본 파일은 서버로 보내지 않는다) */
export interface ImportParser {
  /** 예: "banksalad-xlsx". 서버의 기본 판단(classify)도 이 id 로 찾는다 */
  id: string;
  /** 업로드 화면에 보일 이름 */
  label: string;
  /** 이 소스가 처리할 수 있는 파일인지 판별 (업로드 시 자동 선택용) */
  detect(file: ImportFile): Promise<boolean>;
  parse(file: ImportFile, options: ParseOptions): Promise<ParseResult>;
  /** 거래 외에 재무 스냅샷(자산·부채·대출 등)을 주는 소스 */
  readSnapshot?(file: ImportFile): Promise<Snapshot | null>;
}

/** 서버로 보내는 거래 1건: 브라우저에서 계산한 중복 제거 키를 붙인다 */
export interface ImportRow extends NormalizedTransaction {
  dedupeKey: string;
}

/** 가져오기 미리보기·저장 요청 */
export interface ImportPayload {
  source: string;
  fileName: string;
  /** 원본 파일 SHA-256 (파일은 보내지 않고 해시만 기록) */
  fileSha256: string;
  rows: ImportRow[];
  skipped: ParseResult["skipped"];
  snapshot: Snapshot | null;
  /** 스냅샷 기준일 (파일 전체의 마지막 날). 나눠 보낼 때 조각마다 기간이 달라서 따로 준다 */
  asOf?: string;
  /** 나눠 보낼 때 두 번째 조각부터: 첫 조각 저장에서 받은 가져오기 기록 id */
  batchId?: number;
}

/** 사용자에게 그대로 보여줄 수 있는 가져오기 오류 */
export class ImportError extends Error {}
