-- 현금영수증 (홈택스 사용내역). 승인번호로 중복을 막고, 이미 있는 거래와 연결하거나 새 지출로 추가한다.
CREATE TABLE ledger_cash_receipts (
  approval_no    TEXT PRIMARY KEY,
  date           TEXT NOT NULL,
  time           TEXT,
  merchant       TEXT NOT NULL,
  amount         INTEGER NOT NULL,          -- 원. 취소거래는 음수
  kind           TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'culture')),
  -- existing: 뱅크샐러드 등으로 이미 있던 거래와 연결 / added: 새 지출로 추가 / none: 연결 안 함(취소 등)
  matched        TEXT NOT NULL CHECK (matched IN ('existing', 'added', 'none')),
  transaction_id INTEGER REFERENCES ledger_transactions(id) ON DELETE SET NULL,
  imported_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ledger_cash_receipts_date ON ledger_cash_receipts (date);
CREATE UNIQUE INDEX ledger_cash_receipts_tx ON ledger_cash_receipts (transaction_id) WHERE transaction_id IS NOT NULL;
