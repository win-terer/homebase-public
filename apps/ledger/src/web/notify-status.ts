import type { NotifyOverview, SyncStatus } from "./api.ts";

/**
 * 알림 화면의 "살아 있나" 판정 (화면 로직은 여기, 그리기는 NotifyPage.tsx).
 *
 * 폰 알림 전달(아이폰 단축어)과 집 맥북 자동 가져오기(ledger-sync)는 둘 다 **조용히 죽는다.**
 * 죽어도 가계부는 "오늘 쓴 게 없네" 로 보일 뿐이다. 그래서 마지막 소식이 얼마나 오래됐는지로
 * 먼저 말해 준다 — 기준은 느슨하게: 하루 이틀 카드 안 쓰는 날은 흔하다.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 폰 알림이 이보다 오래 없으면 단축어가 꺼진 것일 수 있다 */
export const NOTIFY_QUIET_MS = 2 * DAY;
/** 자동 가져오기는 10분마다 보고한다. 이보다 오래 소식이 없으면 스크립트·맥북이 멈춘 것 */
export const SYNC_QUIET_MS = 3 * HOUR;
/** 이만큼 연속 실패면 일시적인 게 아니다 */
export const SYNC_FAIL_STREAK = 3;

/** "3분 전" 같은 상대 시각. 미래(시계 오차)는 "방금" */
export function ago(iso: string, now: number): string {
  const d = now - Date.parse(iso);
  if (!Number.isFinite(d) || d < MIN) return "방금";
  if (d < HOUR) return `${Math.floor(d / MIN)}분 전`;
  if (d < DAY) return `${Math.floor(d / HOUR)}시간 전`;
  return `${Math.floor(d / DAY)}일 전`;
}

/** 서울 기준 `10/3 12:08` */
export function seoulStamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t + 9 * HOUR);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export type Level = "ok" | "quiet" | "warn" | "bad";

export interface Verdict {
  level: Level;
  /** 큰 글씨 한 줄 */
  headline: string;
  /** 그 아래 작은 설명 */
  detail: string | null;
}

/** 폰 알림이 오고 있나 */
export function notifyVerdict(status: NotifyOverview["status"], now: number): Verdict {
  if (!status.lastAt) return { level: "quiet", headline: "받은 알림 없음", detail: "아이폰 단축어가 아직 아무것도 보내지 않았어요" };
  const quiet = now - Date.parse(status.lastAt) > NOTIFY_QUIET_MS;
  return {
    level: quiet ? "warn" : "ok",
    headline: ago(status.lastAt, now),
    detail: quiet
      ? "이틀 넘게 조용해요 — 폰의 단축어 자동화가 꺼졌는지 확인해 보세요"
      : `${status.lastApp ?? "앱"} · ${seoulStamp(status.lastAt)}`,
  };
}

/** 집 맥북의 자동 가져오기가 돌고 있나 */
export function syncVerdict(sync: SyncStatus | null, now: number): Verdict {
  if (!sync) return { level: "quiet", headline: "보고 없음", detail: "집 맥북의 ledger-sync 가 아직 상태를 보내지 않았어요" };
  if (now - Date.parse(sync.lastReportAt) > SYNC_QUIET_MS) {
    return {
      level: "warn",
      headline: `${ago(sync.lastReportAt, now)} 이후 소식 없음`,
      detail: "집 맥북이 잠들었거나 ledger-sync 가 멈춘 것 같아요",
    };
  }
  if (sync.failStreak >= SYNC_FAIL_STREAK) {
    return {
      level: "bad",
      headline: `${sync.failStreak}번 연속 실패`,
      detail: [sync.lastStep, sync.lastError].filter(Boolean).join(" — ") || null,
    };
  }
  if (sync.failStreak > 0) {
    return {
      level: "ok",
      headline: sync.lastOkAt ? `${ago(sync.lastOkAt, now)} 성공` : "아직 성공한 적 없음",
      detail: `방금은 실패 (${[sync.lastStep, sync.lastError].filter(Boolean).join(" — ")}) — 다음 번에 다시 해요`,
    };
  }
  return { level: "ok", headline: `${ago(sync.lastOkAt ?? sync.lastReportAt, now)} 성공`, detail: `마지막 보고 ${seoulStamp(sync.lastReportAt)}` };
}
