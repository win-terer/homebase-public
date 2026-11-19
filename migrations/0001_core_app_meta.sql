-- 공용 key/value 메타 정보 (DB 생성 시각, 스키마 관련 플래그 등)
CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_meta (key, value)
VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
