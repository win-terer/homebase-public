-- 일정(캘린더) 앱. 카테고리별로 색을 두고, 화면에서 카테고리를 끄고 볼 수 있다(hidden).
CREATE TABLE calendar_categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO calendar_categories (name, color, sort) VALUES ('일정', 'blue', 0), ('약속', 'green', 1);

-- 일정. 날짜는 Asia/Seoul 기준 'YYYY-MM-DD', 시각 'HH:MM' (없으면 종일). end_date 는 마지막 날(포함).
-- 반복은 매주(시작일의 요일) / 매달(시작일의 날짜, 없는 날은 말일)만. skip_dates = 반복 중 뺀 날짜(JSON 배열)
CREATE TABLE calendar_events (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER REFERENCES calendar_categories(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  start_date   TEXT NOT NULL,
  end_date     TEXT NOT NULL,
  start_time   TEXT,
  end_time     TEXT,
  location     TEXT,
  memo         TEXT,
  repeat       TEXT CHECK (repeat IN ('weekly', 'monthly')),
  repeat_until TEXT,
  skip_dates   TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 한 번짜리 일정: 시작일로 찾는다 (일정 길이는 최대 62일이라 시작일 범위로 충분)
CREATE INDEX calendar_events_start ON calendar_events (start_date) WHERE repeat IS NULL;
-- 반복 일정은 몇 개 안 되니 따로 모아 둔다
CREATE INDEX calendar_events_repeat ON calendar_events (start_date) WHERE repeat IS NOT NULL;
