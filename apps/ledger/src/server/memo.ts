/**
 * 거래 한 건의 메모는 DB 의 memo 칸 하나에 둔다.
 * - 첫 줄: 한 줄 메모 (달력에 가맹점 대신 보임)
 * - 둘째 줄부터: 상세 메모 (주문 품목 등, 날짜 상세에서만 보임)
 * 칸을 따로 만들지 않은 이유: 배포가 코드 → 마이그레이션 순서라 새 칸을 읽는 코드가 먼저 올라가면 깨지고,
 * 검색도 한 칸만 훑으면 된다.
 */
export const MEMO_MAX = 200;
export const NOTE_MAX = 2000;

export function splitMemo(raw: string | null): { memo: string | null; note: string | null } {
  if (!raw) return { memo: null, note: null };
  const i = raw.indexOf("\n");
  if (i < 0) return { memo: raw, note: null };
  return { memo: raw.slice(0, i).trim() || null, note: raw.slice(i + 1).trim() || null };
}

export function joinMemo(memo: string | null, note: string | null): string | null {
  const line = (memo ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim().slice(0, MEMO_MAX);
  const detail = (note ?? "").replace(/\r\n?/g, "\n").trim().slice(0, NOTE_MAX);
  if (!detail) return line || null;
  return `${line}\n${detail}`;
}
