import type { SqlDb } from "@homebase/db";

/**
 * 지금 누가 보고 있나 — 주인과 동거인이 서로를 본다.
 *
 * 화면이 1분마다 제 줄을 덮어쓰고 모든 줄을 읽는다. 실시간(WebSocket)은 Durable Objects 가
 * 필요하고 그건 유료 플랜이라, 여기서는 **최대 1분 늦은 상태**를 보여 주는 것으로 한다.
 *
 * 부르는 쪽은 `c.set("skipRevBump", true)` 를 꼭 켠다 — 이 쓰기는 일정이 바뀐 게 아니다.
 * 데이터 버전이 1분마다 오르면 화면 캐시가 그때마다 깨진다 (migrations/0016 주석 참고).
 */
export type Who = "owner" | "guest";

export interface Seen {
  who: Who;
  seenAt: string;
}

/**
 * 둘을 뭐라고 부를지. **이름은 설정에만 둔다** — 코드에 적으면 공개판에 그대로 올라간다
 * (저장소에 실제 값을 옮기지 않는다는 규칙).
 */
export interface Names {
  owner: string;
  guest: string;
}

export const NAME_KEYS = { owner: "presence.name.owner", guest: "presence.name.guest" } as const;
export const NAME_MAX = 10;
const DEFAULT_NAMES: Names = { owner: "주인", guest: "동거인" };

/** 정해 둔 이름 (안 정했으면 기본값) */
export async function presenceNames(db: SqlDb): Promise<Names> {
  const rows = await db
    .prepare("SELECT key, value FROM app_meta WHERE key IN (?, ?)")
    .bind(NAME_KEYS.owner, NAME_KEYS.guest)
    .all<{ key: string; value: string }>()
    .catch(() => ({ results: [] }));
  const pick = (k: string) => rows.results.find((r) => r.key === k)?.value?.trim();
  return { owner: pick(NAME_KEYS.owner) || DEFAULT_NAMES.owner, guest: pick(NAME_KEYS.guest) || DEFAULT_NAMES.guest };
}

/** 이름을 정한다. 비우면 기본값으로 되돌린다 */
export async function setPresenceNames(db: SqlDb, names: Partial<Names>): Promise<void> {
  for (const who of ["owner", "guest"] as const) {
    const value = names[who]?.trim().slice(0, NAME_MAX);
    if (value === undefined) continue;
    if (!value) {
      await db.prepare("DELETE FROM app_meta WHERE key = ?").bind(NAME_KEYS[who]).run();
      continue;
    }
    await db
      .prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(NAME_KEYS[who], value)
      .run();
  }
}

/** 표가 아직 없으면(배포는 코드 → 마이그레이션 순서다) 조용히 빈 값 — 화면이 깨지지 않게 */
const missingTable = (e: unknown) => /no such table/i.test(String((e as Error)?.message ?? e));

/**
 * 내 줄을 지금으로 덮고, 둘의 상태와 **지금 데이터 버전**을 돌려준다.
 *
 * 버전을 같이 싣는 이유: 이 요청은 어차피 1분마다 간다. 거기에 숫자 하나를 얹으면 화면이
 * **왕복을 더 늘리지 않고** "그새 뭔가 바뀌었나" 를 안다 — 상대가 적은 일정이 1분 안에 보인다.
 * (손님은 `/api/rev` 를 볼 수 없는데, 이 숫자는 데이터가 아니라 꼬리표라 내줘도 된다.)
 */
export async function touchPresence(db: SqlDb, me: Who): Promise<{ seen: Seen[]; rev: string; names: Names }> {
  const now = new Date().toISOString();
  // 버전·이름을 한 번에 — 1분마다 오는 요청이라 쿼리를 늘리지 않는다
  const meta = await db
    .prepare("SELECT key, value FROM app_meta WHERE key IN ('data.rev', ?, ?)")
    .bind(NAME_KEYS.owner, NAME_KEYS.guest)
    .all<{ key: string; value: string }>()
    .catch(() => ({ results: [] }));
  const pick = (k: string) => meta.results.find((r) => r.key === k)?.value?.trim();
  const rev = pick("data.rev") ?? "0";
  const names: Names = { owner: pick(NAME_KEYS.owner) || DEFAULT_NAMES.owner, guest: pick(NAME_KEYS.guest) || DEFAULT_NAMES.guest };
  try {
    await db
      .prepare(
        `INSERT INTO core_presence (who, seen_at) VALUES (?, ?)
         ON CONFLICT (who) DO UPDATE SET seen_at = excluded.seen_at`,
      )
      .bind(me, now)
      .run();
    const rows = await db.prepare("SELECT who, seen_at AS seenAt FROM core_presence").all<Seen>();
    return { seen: rows.results, rev, names };
  } catch (e) {
    if (missingTable(e)) return { seen: [], rev, names };
    throw e;
  }
}
