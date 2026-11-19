-- 폰 알림 원문 보관함.
--
-- 아이폰 단축어(iOS 27 의 '알림을 받았을 때' 자동화)가 카드사·은행 앱 알림을 그대로 쏴 준다.
-- **여기서는 해석하지 않고 원문만 쌓는다** — 앱마다 문구가 달라서, 실제로 어떤 모양으로
-- 오는지 보고 나서 파서를 짜야 한다. 해석은 나중에 붙인다(parsed_at 이 그때 채워진다).
--
-- 거래로 만들 수 없는 알림(광고·잔액 안내)도 그대로 둔다. 무엇을 걸러야 하는지 알려면 필요하다.
CREATE TABLE ledger_notifications (
  id          INTEGER PRIMARY KEY,
  -- 알림이 폰에 온 시각(기기 기준 문자열 그대로). 서버 도착 시각과 다를 수 있다
  sent_at     TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  app         TEXT,
  title       TEXT,
  subtitle    TEXT,
  body        TEXT,
  -- 해석해서 거래로 만든 시각. NULL 이면 아직 안 봤거나 거래가 아니라고 판단한 것
  parsed_at   TEXT
);

CREATE INDEX idx_ledger_notifications_received ON ledger_notifications (received_at DESC);
