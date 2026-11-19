-- 앱 알림으로 들어온 줄만 빠르게 찾기.
--
-- 엑셀을 가져올 때마다 그 기간의 알림 줄을 찾아(메모·분류를 옮기려고) 지운다. 그런데
-- `source = 'notify'` 로 거르면 날짜 인덱스만으로는 **그 기간의 모든 기록**을 훑게 된다.
-- 7,000건 기준 한 조각 가져오기에 읽기가 1만 → 1.7만으로 뛰었다.
--
-- 부분 인덱스로 알림 줄만 담는다. 보통 몇 건뿐이라 거의 공짜가 되고, 엑셀이 확정되면
-- 지워지므로 인덱스도 계속 작게 유지된다.
CREATE INDEX idx_ledger_transactions_notify ON ledger_transactions (date) WHERE source = 'notify';
