-- 사용자 설정 (연말정산용 총급여, 결제수단 구분 등). 개인 값은 DB 에만 둔다.
CREATE TABLE ledger_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
