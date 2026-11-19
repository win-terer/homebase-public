import type { Hono } from "hono";
import type { SqlDb } from "@homebase/db";
import type { PhotoKV } from "./photos.ts";

/** 워커가 앱 API 에 넘겨주는 바인딩. 테스트에서는 `api.request(path, init, { DB })` 로 넘긴다 */
export interface AppBindings {
  DB: SqlDb;
  /** 사진 바이트 (KV homebase-img). 없으면 사진 기능만 꺼진다 — 항목 삭제는 그대로 된다 (photos.ts) */
  PHOTOS?: PhotoKV;
  /**
   * 설정에 섞인 비밀값(메일 비밀번호 등)을 봉하는 열쇠 (워커 Secret). 없으면 **비밀값은 저장하지
   * 않는다** — 평문으로 두느니 기능을 끈다 (@homebase/core/secrets).
   */
  SETTINGS_KEY?: string;
  /**
   * 가져오기 전용 키 (워커 Secret). 메일에서 엑셀을 올려 주는 도구가 쓴다. 여기서는 **연결 코드로
   * 한 번 내주기 위해서만** 읽는다 — 설치하는 사람이 대시보드를 뒤지지 않아도 되게.
   */
  IMPORT_TOKEN?: string;
}

/**
 * `skipRevBump`: 이 요청의 쓰기는 가계부 내용이 아니라 살림(상태 보고 같은 것)이라 데이터 버전을
 * 올리지 말라는 표시. 핸들러가 `c.set("skipRevBump", true)` 로 켠다 (host app.ts 가 본다).
 */
export type AppEnv = { Bindings: AppBindings; Variables: { skipRevBump?: boolean } };

/**
 * 앱(apps/*)이 서버 쪽에 제공하는 계약. host 가 /api/<id> 에 마운트한다.
 * DB 테이블은 `<id>_` 접두어를 쓰고, 마이그레이션은 저장소 루트 `migrations/` 에 `NNNN_<id>_이름.sql` 로 둔다.
 */
export interface ServerModule {
  /** URL·DB 테이블 접두어로 쓰이는 짧은 id. 예: "ledger" */
  id: string;
  createApi(): Hono<AppEnv>;
}
