-- OTP 를 **안 쓰기로 고를 수 있게** 한다 (사용자 요청 2026-11-20).
--
-- 설치하자마자 QR 부터 찍으라고 하면 거기서 그만두는 사람이 생긴다. 그렇다고 OTP 를 빼면
-- 비밀번호 하나로 가계부가 열린다. 그래서 **고르게** 둔다 — 권하는 쪽은 그대로 OTP 다.
--
-- skipped = 1 이면 로그인에서 코드를 묻지 않는다. confirmed 는 그대로 1 로 둔다 —
-- '설정이 끝났나' 를 보는 자리가 여러 군데라, 거기에 조건을 하나 더 더하면 빠뜨리기 쉽다.
ALTER TABLE auth_totp ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;
