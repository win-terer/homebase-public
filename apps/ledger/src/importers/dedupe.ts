import type { ImportRow, NormalizedTransaction } from "./types.ts";

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 중복 제거 키를 붙인다. 승인번호가 있으면 `소스+결제수단+승인번호`, 없으면
 * `소스+결제수단+날짜+시각+금액+가맹점+순번`. 순번은 같은 파일 안에서 위 값이 완전히 같은
 * 건(같은 가게에서 같은 금액 두 번 결제)을 구분한다. 제외 여부와 무관하게 모든 행에 매겨서,
 * 규칙이 바뀌어도 키가 달라지지 않게 한다.
 */
export async function withDedupeKeys(sourceId: string, txs: NormalizedTransaction[]): Promise<ImportRow[]> {
  const occurrences = new Map<string, number>();
  return Promise.all(
    txs.map((tx) => {
      const base = [sourceId, tx.paymentMethod, tx.date, tx.time ?? "", tx.amount, tx.merchant].join("\u001f");
      const n = occurrences.get(base) ?? 0;
      occurrences.set(base, n + 1);
      const key = tx.externalId ? [sourceId, tx.paymentMethod, tx.externalId].join("\u001f") : `${base}\u001f${n}`;
      return sha256(key).then((dedupeKey) => ({ ...tx, dedupeKey }));
    }),
  );
}
