-- 로그인 (비밀번호 + OTP). 비밀번호는 워커 Secret(LOGIN_PASSWORD)에만 있고 DB 에는 없다.

-- OTP(TOTP) 비밀. 한 줄만 둔다. confirmed = 0 은 /setup 에서 QR 을 보여주고 아직 코드를 맞추지 않은 상태
CREATE TABLE auth_totp (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  secret          TEXT NOT NULL,             -- base32
  confirmed       INTEGER NOT NULL DEFAULT 0,
  setup_token     TEXT,                      -- 등록 중인 브라우저 확인용 토큰의 해시
  last_counter    INTEGER NOT NULL DEFAULT 0, -- 마지막으로 쓴 코드의 시간 칸 (같은 코드 재사용 방지)
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 로그인 세션. 쿠키 값은 저장하지 않고 SHA-256 해시만 둔다
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 틀린 로그인 시도 (IP 는 해시로만). 시도 제한에 쓰고 오래된 건 지운다
CREATE TABLE auth_fails (
  ip_hash TEXT NOT NULL,
  ts      INTEGER NOT NULL                   -- epoch ms
);
CREATE INDEX auth_fails_ts ON auth_fails (ts);
