-- 지금 누가 보고 있나 (주인 · 동거인). 줄은 둘뿐이다.
--
-- 구글 시트 같은 실시간은 WebSocket(Durable Objects)이 필요한데 그건 유료 플랜이라, 화면이
-- 1분마다 제 줄을 덮어쓰고 상대 줄을 읽는 방식으로 한다. 둘이 하루 종일 켜 둬도 쓰기 2,880행
-- (D1 무료 한도 10만의 2.9%)이고, 탭을 숨기면 멈춘다.
--
-- **이 표를 쓸 때 데이터 버전(data.rev)을 올리지 않는다** (host app.ts 의 skipRevBump).
-- 올리면 1분마다 화면 캐시와 전체 훑기 캐시가 깨져서, 느려지지 않으려고 만든 3층 캐시가 무너진다.
CREATE TABLE core_presence (
  who     TEXT PRIMARY KEY,  -- 'owner' | 'guest'
  seen_at TEXT NOT NULL
);
