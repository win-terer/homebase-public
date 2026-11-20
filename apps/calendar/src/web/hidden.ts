/**
 * 끄고 보는 카테고리.
 *
 * 주인은 **설정(서버)** 에 남긴다 — 기기를 바꿔도 따라온다. 동거인은 **제 브라우저에만**
 * 남긴다. 주인 설정을 건드리면 주인 화면까지 같이 바뀌기 때문이다.
 *
 * 달력과 할 일이 같은 값을 본다 — 카테고리가 하나뿐이니 끈 것도 하나여야 한다.
 */
export const GUEST_HIDDEN_KEY = "hb.guest.hidden";

export function readGuestHidden(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(GUEST_HIDDEN_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export function writeGuestHidden(ids: readonly number[]): void {
  try {
    localStorage.setItem(GUEST_HIDDEN_KEY, JSON.stringify(ids));
  } catch {
    // 사생활 보호 모드 등 — 못 적어도 이번 방문 동안은 동작한다
  }
}
