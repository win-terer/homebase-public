-- 이체 규칙을 4가지 처리(제외 / 이체로 포함 / 지출로 / 수입으로)와 카테고리로 확장한다.
-- 0001 의 규칙(include/exclude)은 화면이 없던 시기라 비어 있으므로 새로 만든다.
DROP TABLE ledger_transfer_rules;

CREATE TABLE ledger_transfer_rules (
  -- 상대방 이름에서 뒤 숫자를 뗀 값 (예: '○○생명01000' → '○○생명')
  counterparty TEXT PRIMARY KEY,
  action       TEXT NOT NULL CHECK (action IN ('exclude', 'transfer', 'expense', 'income')),
  category_id  INTEGER REFERENCES ledger_categories(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
