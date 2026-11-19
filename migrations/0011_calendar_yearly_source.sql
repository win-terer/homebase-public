-- 일정: 매년 반복(생일·기념일) 추가, 가져온 일정의 원래 ID(source_uid, 구글 캘린더 UID)로 다시 가져와도 중복 안 되게.
-- SQLite 는 CHECK 를 바꿀 수 없어서 표를 새로 만들어 옮긴다 (0010 직후라 행이 적다).
CREATE TABLE calendar_events_new (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER REFERENCES calendar_categories(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  start_time   TEXT,
  end_time     TEXT,
  location     TEXT,
  memo         TEXT,
  repeat       TEXT CHECK (repeat IN ('weekly', 'monthly', 'yearly')),
  repeat_until TEXT,
  skip_dates   TEXT NOT NULL DEFAULT '[]',
  source_uid   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO calendar_events_new (id, category_id, title, start_date, end_date, start_time, end_time, location, memo, repeat, repeat_until, skip_dates, created_at, updated_at)
SELECT id, category_id, title, start_date, end_date, start_time, end_time, location, memo, repeat, repeat_until, skip_dates, created_at, updated_at FROM calendar_events;

DROP TABLE calendar_events;
ALTER TABLE calendar_events_new RENAME TO calendar_events;

CREATE INDEX calendar_events_start ON calendar_events (start_date) WHERE repeat IS NULL;
CREATE INDEX calendar_events_repeat ON calendar_events (start_date) WHERE repeat IS NOT NULL;
CREATE UNIQUE INDEX calendar_events_source ON calendar_events (source_uid) WHERE source_uid IS NOT NULL;
