-- 할 일. **날짜가 정해지지 않은 것**을 담으려고 일정(calendar_events)과 따로 둔다 —
-- 달력은 날짜가 뼈대라 날짜 없는 줄을 올릴 수 없고, 억지로 끼우면 달력 질의를 전부 건드려야 한다.
--
-- 카테고리는 **일정 것을 같이 쓴다**(calendar_categories). 그래야 한 카테고리를 함께 보기로 켜면
-- 그 카테고리의 일정도 할 일도 한 번에 열린다 — 공유 설정이 둘로 늘지 않는다.
--
-- due_kind: someday(언젠가) | week(이번 주) | month(이번 달) | date(날짜 지정)
-- due_date: week·month 는 **그 기간의 마지막 날**을 적어 둔다. 정렬도 '지났나' 판정도 이 한 칸으로 끝난다
--           (someday 는 비어 있다). '이번 주' 라고만 적어 두면 다음 주에도 '이번 주' 라 영영 안 지난다.
-- done_at:  비어 있으면 아직 안 끝난 것. 지우지 않고 남겨 둔다 — 잘못 눌렀을 때 되돌려야 한다.
CREATE TABLE calendar_todos (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER,
  title       TEXT NOT NULL,
  memo        TEXT,
  due_kind    TEXT NOT NULL DEFAULT 'someday',
  due_date    TEXT,
  done_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 목록은 늘 '안 끝난 것 / 끝난 것' 으로 갈라서 기한순으로 본다
CREATE INDEX calendar_todos_open ON calendar_todos (done_at, due_date);
