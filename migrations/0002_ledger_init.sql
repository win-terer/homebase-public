-- 카테고리 (2단계: 대분류 > 소분류). 목록은 관리 화면에서 만든다.
CREATE TABLE ledger_categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES ledger_categories(id) ON DELETE CASCADE,
  color      TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ledger_categories_name ON ledger_categories (ifnull(parent_id, 0), name);

-- 가져오기 기록. 원본 파일은 저장하지 않고 해시만 남긴다.
CREATE TABLE ledger_import_batches (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  period_from TEXT,
  period_to   TEXT,
  total_rows  INTEGER NOT NULL,
  inserted    INTEGER NOT NULL,
  duplicates  INTEGER NOT NULL,
  excluded    INTEGER NOT NULL,
  skipped     INTEGER NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE ledger_transactions (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer')),
  -- review: 가져올지 사용자 확인이 필요한 이체 (통계·달력에서 제외)
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'review')),
  date            TEXT NOT NULL,             -- YYYY-MM-DD (Asia/Seoul)
  time            TEXT,                      -- HH:MM:SS, 없으면 NULL
  merchant        TEXT NOT NULL,             -- 소스에 찍힌 가맹점·상대방 이름
  amount          INTEGER NOT NULL,          -- 원. 나간 돈 음수, 들어온 돈 양수
  payment_method  TEXT,
  category_id     INTEGER REFERENCES ledger_categories(id) ON DELETE SET NULL,
  category_source TEXT CHECK (category_source IN ('source', 'rule', 'manual')),
  source_category TEXT,                      -- 소스가 준 원래 카테고리 (참고용)
  memo            TEXT,                      -- 한 줄 메모. 달력에서 가맹점보다 우선 표시
  -- 정산: 받은 돈(이체 입금)이 어떤 결제의 정산인지. 통계에서 그 결제의 실부담액을 줄인다
  settles_id      INTEGER REFERENCES ledger_transactions(id) ON DELETE SET NULL,
  source          TEXT NOT NULL,             -- 가져오기 소스 id 또는 'manual'
  import_batch_id INTEGER REFERENCES ledger_import_batches(id),
  dedupe_key      TEXT UNIQUE,               -- 수동 입력은 NULL
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ledger_transactions_date ON ledger_transactions (date, time);
CREATE INDEX ledger_transactions_merchant ON ledger_transactions (merchant);
CREATE INDEX ledger_transactions_settles ON ledger_transactions (settles_id);

-- 이체 상대방별 사용자 결정. 소스의 기본 판단보다 우선한다.
CREATE TABLE ledger_transfer_rules (
  counterparty TEXT PRIMARY KEY,
  action       TEXT NOT NULL CHECK (action IN ('include', 'exclude')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
