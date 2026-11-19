import { useEffect, useSyncExternalStore } from "react";

/**
 * 금액 가리기: `hb-secret` 클래스가 붙은 숫자(월 합계·KPI·연말정산 금액 등)를 흐리게 보여준다.
 * 사무실처럼 남이 볼 수 있는 곳을 위해 기본은 가림. 숫자를 누르면 그것만 10초 동안 보인다.
 * 헤더 스위치로 전부 보이게 할 수 있고, 이 선택은 기기(브라우저)마다 기억한다.
 *
 * 상태를 모듈에 두는 이유: 헤더 스위치 말고 **우클릭 메뉴에서도** 같은 값을 켜고 끈다.
 * 둘이 각자 state 를 들면 한쪽을 바꿔도 다른 쪽 모양이 안 따라온다.
 */
const KEY = "hb.privacy";
const REVEAL_MS = 10_000;

function readMode(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    // 저장이 막힌 브라우저에서는 가린 쪽이 안전하다
    return true;
  }
}

let hidden = readMode();
const listeners = new Set<() => void>();

export function privacyHidden(): boolean {
  return hidden;
}

export function setPrivacyHidden(next: boolean): void {
  hidden = next;
  document.documentElement.dataset.privacy = hidden ? "on" : "off";
  try {
    localStorage.setItem(KEY, hidden ? "on" : "off");
  } catch {
    // 저장이 막힌 브라우저에서도 이번 방문 동안은 동작한다
  }
  listeners.forEach((f) => f());
}

function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

export function usePrivacyHidden(): boolean {
  return useSyncExternalStore(subscribe, privacyHidden, () => true);
}

export function PrivacyToggle() {
  const isHidden = usePrivacyHidden();

  // 첫 그림에 맞춰 문서에도 한 번 찍어 둔다 (새로고침 직후)
  useEffect(() => {
    document.documentElement.dataset.privacy = isHidden ? "on" : "off";
  }, [isHidden]);

  // 가린 숫자를 누르면 그것만 잠깐 보이기
  useEffect(() => {
    const timers = new Map<Element, number>();
    const onClick = (e: MouseEvent) => {
      if (document.documentElement.dataset.privacy === "off") return;
      const el = (e.target as Element | null)?.closest?.(".hb-secret");
      if (!el) return;
      const revealed = el.classList.toggle("is-revealed");
      window.clearTimeout(timers.get(el));
      if (revealed) timers.set(el, window.setTimeout(() => el.classList.remove("is-revealed"), REVEAL_MS));
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  return (
    <button
      type="button"
      className="hb-privacy"
      role="switch"
      aria-checked={!isHidden}
      title={isHidden ? "금액이 가려져 있어요. 누르면 모두 보여요" : "금액이 보여요. 누르면 가려요"}
      onClick={() => setPrivacyHidden(!isHidden)}
    >
      <span className="hb-privacy-track" aria-hidden="true">
        <span className="hb-privacy-thumb" />
      </span>
      금액 보기
    </button>
  );
}
