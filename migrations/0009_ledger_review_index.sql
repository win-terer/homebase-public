-- 0008 의 status 인덱스는 'active'(거의 전부) 조회에도 선택돼서 날짜 인덱스 대신 전체를 훑게 만들었다.
-- 확인 필요(review) 건만 담는 부분 인덱스로 바꾼다. (d1-budget.test.ts 로 확인)
DROP INDEX IF EXISTS ledger_transactions_status;
CREATE INDEX IF NOT EXISTS ledger_transactions_review ON ledger_transactions (status) WHERE status = 'review';
