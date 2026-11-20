-- 동거인(손님) 로그인. 주인 세션(auth_sessions)과 **표를 따로** 둔다 — 한 표에 역할 칸으로 섞으면
-- 한쪽 조회에서 조건 하나를 빠뜨릴 때 다른 쪽이 통째로 열린다. 쿠키 이름도 따로다.
--
-- 손님은 비밀번호만으로 들어온다(기본은 주인 것과 같은 값, 따로 두려면 Secret GUEST_PASSWORD).
-- OTP 를 안 받는 이유: 열리는 게 일정 한 카테고리뿐이고(apps/calendar/src/server/guest.ts), 밥 준 걸
-- 폰에서 바로 적는 게 목적이라 매번 코드를 치게 하면 안 쓰게 된다. 비밀번호가 같아도 주인 자리는
-- OTP 가 한 겹 더 막는다. 문을 여닫는 스위치는 비밀번호가 아니라 '함께 보기' 카테고리 설정이다.
CREATE TABLE auth_guest_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
