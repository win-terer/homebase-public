/**
 * 지금 상대가 보고 있는지 — 주인과 동거인이 서로를 본다.
 *
 * 구글 시트 같은 실시간은 WebSocket(Durable Objects)이 필요하고 그건 유료 플랜이라,
 * **1분마다 한 줄 덮어쓰고 읽는** 방식으로 한다. 최대 1분 늦다.
 *
 * 아껴 쓰는 장치 둘:
 * - 탭이 안 보이면 멈춘다 (다른 탭을 보는 동안 D1 을 긁지 않는다)
 * - 서버가 데이터 버전을 올리지 않는다 (올리면 1분마다 화면 캐시가 통째로 깨진다)
 *
 * 둘이 하루 종일 켜 둬도 쓰기 2,880행 — D1 무료 한도(10만)의 2.9% 다.
 */
import { useEffect, useRef, useState } from "react";
import type { Names, Seen, Who } from "@homebase/core/presence";
import { calendarApi } from "./api.ts";

const EVERY_MS = 60_000;
/** 이 안에 다녀갔으면 '보는 중' */
const FRESH_MS = 2 * 60_000;

/**
 * @param onChanged 그새 데이터가 바뀌었을 때 (상대가 적은 일정을 다시 받으라는 신호).
 *   **고치는 중에는 부르지 않는다** — 적던 내용이 날아가면 안 된다. 다음 확인 때 다시 걸린다.
 * @param busy 지금 뭔가 고치는 중인가
 */
export function usePresence(onChanged?: () => void, busy = false): { seen: Seen[]; names: Names } {
  const [seen, setSeen] = useState<Seen[]>([]);
  const [names, setNames] = useState<Names>({ owner: "주인", guest: "동거인" });
  // 본 적 있는 데이터 버전. 처음 받은 값은 기준점으로만 쓴다(첫 응답에 새로고침하면 두 번 받는다)
  const rev = useRef<string | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const paused = useRef(busy);
  paused.current = busy;

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void calendarApi.presence().then((r) => {
        if (!alive) return;
        setSeen(r.seen);
        setNames(r.names);
        if (rev.current !== null && rev.current !== r.rev && !paused.current) changed.current?.();
        // 고치는 중이면 기준점을 안 옮긴다 — 다 적고 나면 다음 확인에서 걸린다
        if (!paused.current || rev.current === null) rev.current = r.rev;
      }, () => {}); // 표가 아직 없거나 잠깐 실패 — 이 기능 때문에 화면이 깨지면 안 된다
    };
    tick();
    const timer = setInterval(tick, EVERY_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return { seen, names };
}

/** `3분 전` · `어제` 같은 말 */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "방금";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}시간 전`;
  const day = Math.floor(hour / 24);
  return day === 1 ? "어제" : `${day}일 전`;
}

/**
 * 상대가 보고 있는지 한 칸. 내 쪽은 안 보여 준다 — 내가 보고 있는 건 나도 안다.
 * 상대가 한 번도 들어온 적이 없으면 아무것도 그리지 않는다.
 */
export function PresenceDot({ seen, names, me }: { seen: Seen[]; names: Names; me: Who }) {
  const other = seen.find((s) => s.who !== me);
  if (!other) return null;
  const fresh = Date.now() - Date.parse(other.seenAt) < FRESH_MS;
  // 상대의 이름으로 부른다 (설정에서 정한다 — 코드에는 안 적는다)
  const name = me === "owner" ? names.guest : names.owner;
  return (
    <span className={`cal-presence ${fresh ? "is-on" : ""}`} title={`${name} · ${fresh ? "지금 보는 중" : ago(other.seenAt)} (1분마다 확인해요)`}>
      <i aria-hidden="true" />
      {fresh ? `${name} 보는 중` : `${name} ${ago(other.seenAt)}`}
    </span>
  );
}
