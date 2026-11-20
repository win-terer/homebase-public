/**
 * 제목에 카테고리 이름이 들어 있으면 그 분류로 (`반려 자동 급식기 첫사용` → `반려`).
 *
 * 적을 때 분류를 따로 누르는 게 번거롭다는 요청(2026-11-19). **쓰는 사람이 분류를 직접 누르기
 * 전까지만** 거든다 — 고른 것을 덮지 않는다. 가계부에서 메모 낱말로 분류를 덮었다가 원래 쓰임이
 * 사라져 같은 날 되돌린 적이 있다(`server/tags.ts` 참고). 여기서는 **고르기 전 기본값**만 바꾼다.
 *
 * 규칙은 카테고리 이름 하나뿐이라 따로 외울 게 없다. 이름을 바꾸면 규칙도 같이 바뀐다.
 */
export function categoryFromTitle<T extends { id: number; name: string }>(title: string, categories: readonly T[]): number | null {
  const text = title.toLowerCase();
  if (!text.trim()) return null;
  let best: { id: number; len: number } | null = null;
  for (const c of categories) {
    const name = c.name.trim().toLowerCase();
    // 한 글자 이름은 아무 데나 걸린다 ('집' 이 '집들이'·'모집' 에도) — 거들지 않는다
    if (name.length < 2 || !text.includes(name)) continue;
    if (!best || name.length > best.len) best = { id: c.id, len: name.length };
  }
  return best?.id ?? null;
}
