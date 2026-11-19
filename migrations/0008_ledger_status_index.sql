-- 확인 필요 건수(탭 배지)·확인 필요 목록을 전체를 훑지 않고 세도록 (D1 읽기 행 수 절약)
CREATE INDEX IF NOT EXISTS ledger_transactions_status ON ledger_transactions (status);
