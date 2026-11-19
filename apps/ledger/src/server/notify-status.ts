import type { SqlDb } from "@homebase/db";

/**
 * 폰 알림·자동 가져오기가 **살아 있는지** 보여 주기 위한 상태.
 *
 * 둘 다 조용히 죽는다 — 아이폰 단축어 자동화는 iOS 업데이트 뒤 꺼져 있기도 하고, 집 맥북의
 * ledger-sync 는 잠자기·키체인 잠김으로 멈춘다. 멈춰도 가계부는 그냥 "오늘 쓴 게 없네" 로
 * 보일 뿐이라 며칠이 지나서야 안다. 그래서 **마지막으로 소식이 온 시각**을 보여 준다 —
 * 그게 오래됐으면 화면이 먼저 말한다.
 */

/** 집 맥북 ledger-sync 가 돌 때마다 보고하는 결과 (`POST /sync-status`) */
export interface SyncStatus {
  /** 마지막으로 성공한 시각 (ISO) */
  lastOkAt: string | null;
  lastFailAt: string | null;
  /** 연속 실패 횟수. 성공하면 0 */
  failStreak: number;
  /** 마지막 실패의 단계·메시지 (성공하면 비운다) */
  lastStep: string | null;
  lastError: string | null;
  /** 성공이든 실패든 마지막으로 보고가 온 시각 — 이게 오래되면 스크립트 자체가 안 도는 것 */
  lastReportAt: string;
}

export const SYNC_STATUS_KEY = "sync.status";

export async function readSyncStatus(db: SqlDb): Promise<SyncStatus | null> {
  const row = await db.prepare("SELECT value FROM ledger_settings WHERE key = ?").bind(SYNC_STATUS_KEY).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as SyncStatus;
  } catch {
    return null;
  }
}

/** 보고 본문. 모르는 값은 버린다 — 스크립트가 보내는 건 세 칸뿐이다 */
export function readSyncReport(body: unknown): { ok: boolean; step: string | null; error: string | null } | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b.ok !== "boolean") return null;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  return { ok: b.ok, step: str(b.step, 50), error: str(b.error, 200) };
}

/**
 * 보고를 한 줄 설정(`sync.status`)에 접어 넣는다. 성공 보고는 10분마다 오므로 행을 쌓지 않고
 * 한 행을 덮어쓴다. 실패 메시지는 다음 성공 때 지운다 — 고쳐진 문제를 계속 보여 줄 이유가 없다.
 */
export async function recordSyncReport(db: SqlDb, report: { ok: boolean; step: string | null; error: string | null }, now = new Date().toISOString()): Promise<SyncStatus> {
  const prev = await readSyncStatus(db);
  const next: SyncStatus = report.ok
    ? { lastOkAt: now, lastFailAt: prev?.lastFailAt ?? null, failStreak: 0, lastStep: null, lastError: null, lastReportAt: now }
    : {
        lastOkAt: prev?.lastOkAt ?? null,
        lastFailAt: now,
        failStreak: (prev?.failStreak ?? 0) + 1,
        lastStep: report.step,
        lastError: report.error,
        lastReportAt: now,
      };
  await db
    .prepare(
      `INSERT INTO ledger_settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(SYNC_STATUS_KEY, JSON.stringify(next))
    .run();
  return next;
}

/** 알림 화면의 원문 목록 한 줄. 본문은 앞부분만 — 목록에서는 무슨 알림인지 알아볼 정도면 된다 */
export interface RecentNotification {
  id: number;
  sentAt: string | null;
  receivedAt: string;
  app: string | null;
  title: string | null;
  subtitle: string | null;
  excerpt: string | null;
  /** 거래로 읽어 들였는지 */
  parsed: boolean;
}

export const RECENT_LIMIT = 50;

export async function recentNotifications(db: SqlDb): Promise<RecentNotification[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id, sent_at AS sentAt, received_at AS receivedAt, app, title, subtitle, substr(body, 1, 160) AS excerpt,
                parsed_at IS NOT NULL AS parsed
         FROM ledger_notifications ORDER BY received_at DESC, id DESC LIMIT ?`,
      )
      .bind(RECENT_LIMIT)
      .all<Omit<RecentNotification, "parsed"> & { parsed: number }>()
  ).results;
  return rows.map((r) => ({ ...r, parsed: r.parsed === 1 }));
}
