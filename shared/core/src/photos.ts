import type { SqlDb } from "@homebase/db";

/**
 * 사진 첨부 — 서버 공용 (host 의 /api/photos 와, 항목을 지우는 앱 API 가 함께 쓴다).
 *
 * 바이트는 **KV**(바인딩 `PHOTOS`, 네임스페이스 homebase-img)에, 어느 항목 것인지는 D1 `core_photos` 에 둔다.
 * KV 는 결제 수단 없이 쓰는 무료 한도(1GB · 하루 쓰기 1,000회) 안에서 돈다 — 혼자 쓰는 앱이라 넉넉하다.
 * 브라우저가 긴 변 1600px JPEG 와 320px 썸네일로 줄여서 올린다(워커엔 이미지 변환기가 없다). 원본은 남지 않는다.
 *
 * **새 코드가 마이그레이션보다 먼저 올라간다**(배포 = 코드 → 마이그레이션). core_photos 가 아직 없을 때
 * 항목 삭제가 깨지지 않도록, 여기 함수들은 표가 없으면 조용히 아무것도 안 한다.
 */
export const PHOTO_MAX = 3;
/** 사진이 붙는 앱과 그 항목 표 (항목이 있는지 확인할 때 쓴다) */
export const PHOTO_APPS = { calendar: "calendar_events", ledger: "ledger_transactions", todo: "calendar_todos" } as const;
export type PhotoApp = keyof typeof PHOTO_APPS;
export const isPhotoApp = (v: unknown): v is PhotoApp => typeof v === "string" && Object.hasOwn(PHOTO_APPS, v);

/** KV 중 쓰는 것만 (Cloudflare KVNamespace 가 그대로 만족한다. 테스트는 Map 으로 흉내) */
export interface PhotoKV {
  put(key: string, value: ArrayBuffer, options?: { metadata?: unknown }): Promise<void>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

export const photoKey = (id: string, thumb = false) => `p/${id}${thumb ? "_t" : ""}`;

/** 올라오는 사진 크기 한도. 긴 변 1600px JPEG 는 보통 200~500KB 라 넉넉하다 */
export const PHOTO_FULL_MAX = 1536 * 1024;
export const PHOTO_THUMB_MAX = 200 * 1024;

/** JPEG 인가 (브라우저가 줄여서 보낸 것만 받는다 — 원본 HEIC/PNG 는 EXIF·용량 때문에 안 받는다) */
export const isJpeg = (b: ArrayBuffer): boolean => {
  const u = new Uint8Array(b, 0, Math.min(3, b.byteLength));
  return u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff;
};

/** 항목에 붙은 사진 수 */
export const countPhotos = async (db: SqlDb, app: PhotoApp, ref: string): Promise<number> =>
  (await db.prepare("SELECT count(*) AS n FROM core_photos WHERE app = ? AND ref = ?").bind(app, ref).first<{ n: number }>())?.n ?? 0;

/**
 * 올라온 사진 한 장을 저장한다 (host 의 /api/photos 와 손님 API 가 함께 쓴다 — 규칙이 갈라지지 않게).
 *
 * **붙일 항목이 있는지는 부르는 쪽이 먼저 본다** — 손님은 '공유 카테고리 일정인가' 까지 따져야 해서
 * 조건이 다르다. 여기서는 크기·형식·장수만 본다.
 *
 * 바이트를 먼저 넣고 줄을 쓴다 — 줄은 있는데 바이트가 없는 상태(깨진 썸네일)를 만들지 않는다.
 */
export async function savePhoto(
  db: SqlDb,
  kv: PhotoKV,
  app: PhotoApp,
  ref: string,
  full: ArrayBuffer,
  thumb: ArrayBuffer,
  size: { w: number | null; h: number | null },
): Promise<{ id: string } | { error: string; status: 409 | 413 | 415 }> {
  if (full.byteLength > PHOTO_FULL_MAX || thumb.byteLength > PHOTO_THUMB_MAX) return { error: "사진이 너무 커요", status: 413 };
  if (!isJpeg(full) || !isJpeg(thumb)) return { error: "JPEG 로 줄인 사진만 받아요", status: 415 };
  if ((await countPhotos(db, app, ref)) >= PHOTO_MAX) return { error: `사진은 ${PHOTO_MAX}장까지 붙일 수 있어요`, status: 409 };
  const id = crypto.randomUUID().replace(/-/g, "");
  await Promise.all([kv.put(photoKey(id), full, { metadata: { app, ref } }), kv.put(photoKey(id, true), thumb, { metadata: { app, ref } })]);
  await db
    .prepare("INSERT INTO core_photos (id, app, ref, bytes, width, height) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, app, ref, full.byteLength + thumb.byteLength, size.w, size.h)
    .run();
  return { id };
}

const missingTable = (e: unknown) => /no such table/i.test(String((e as Error)?.message ?? e));

/** 항목들을 지울 때 — 그 항목에 붙은 사진도 지운다 (D1 줄 → KV 값 순서. KV 가 실패해도 줄은 이미 없다) */
export async function dropPhotos(db: SqlDb, kv: PhotoKV | undefined, app: PhotoApp, refs: Array<string | number>): Promise<number> {
  if (!refs.length) return 0;
  const list = JSON.stringify(refs.map(String));
  let ids: string[];
  try {
    ids = (
      await db.prepare("SELECT id FROM core_photos WHERE app = ? AND ref IN (SELECT value FROM json_each(?))").bind(app, list).all<{ id: string }>()
    ).results.map((r) => r.id);
    if (!ids.length) return 0;
    await db.prepare("DELETE FROM core_photos WHERE app = ? AND ref IN (SELECT value FROM json_each(?))").bind(app, list).run();
  } catch (e) {
    if (missingTable(e)) return 0;
    throw e;
  }
  if (kv) await Promise.all(ids.flatMap((id) => [kv.delete(photoKey(id)), kv.delete(photoKey(id, true))])).catch(() => {});
  return ids.length;
}

/** 사진을 다른 항목으로 옮긴다 (가계부: 앱알림 임시 줄 → 엑셀로 들어온 진짜 줄). 옮긴 장수 */
export async function movePhotos(db: SqlDb, app: PhotoApp, from: string | number, to: string | number): Promise<number> {
  try {
    const r = await db.prepare("UPDATE core_photos SET ref = ? WHERE app = ? AND ref = ?").bind(String(to), app, String(from)).run();
    return r.meta.changes;
  } catch (e) {
    if (missingTable(e)) return 0;
    throw e;
  }
}

/** 사진이 붙은 항목 id 들 (refs 중에서) */
export async function refsWithPhotos(db: SqlDb, app: PhotoApp, refs: Array<string | number>): Promise<Set<string>> {
  if (!refs.length) return new Set();
  try {
    const rows = await db
      .prepare("SELECT DISTINCT ref FROM core_photos WHERE app = ? AND ref IN (SELECT value FROM json_each(?))")
      .bind(app, JSON.stringify(refs.map(String)))
      .all<{ ref: string }>();
    return new Set(rows.results.map((r) => r.ref));
  } catch (e) {
    if (missingTable(e)) return new Set();
    throw e;
  }
}
