-- 사진 첨부 (일정·가계부 거래 공용). 사진 바이트는 KV(PHOTOS)에, 여기에는 어느 항목의 몇 번째 사진인지만.
-- app = 'calendar' | 'ledger', ref = 그 앱의 항목 id(문자열). 항목 하나에 3장까지(코드에서 막음).
-- 브라우저가 긴 변 1600px JPEG + 320px 썸네일로 줄여 올린다 — 원본·EXIF(위치)는 남지 않는다.
CREATE TABLE core_photos (
  id         TEXT PRIMARY KEY,
  app        TEXT NOT NULL,
  ref        TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX core_photos_ref ON core_photos (app, ref);
