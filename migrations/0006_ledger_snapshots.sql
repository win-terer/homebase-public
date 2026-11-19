-- 뱅크샐러드 내보내기 첫 페이지(뱅샐현황)의 재무 스냅샷. 내보낸 시점마다 하나씩 쌓는다.
-- 이름·이메일은 저장하지 않는다.
CREATE TABLE ledger_snapshots (
  as_of        TEXT PRIMARY KEY,              -- 기준일 (내보내기 기간의 마지막 날)
  credit_score INTEGER,
  data         TEXT NOT NULL,                 -- JSON: assets, debts, loans, investments
  imported_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
