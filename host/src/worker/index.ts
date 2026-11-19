/** Cloudflare Workers 입구: 로그인 → API(/api/*) → 화면 파일 */
import { countReads, REQUEST_READ_BUDGET, type SqlDb } from "@homebase/db";
import { createApp, type Env } from "./app.ts";

const app = createApp();

// 요청마다 읽기를 세서 REQUEST_READ_BUDGET(@homebase/db)을 넘으면 그 요청의 나머지 쿼리를 막는다.

/** 이보다 많이 읽은 요청은 로그에 남긴다 (대시보드 Observability 에서 확인) */
const READ_WARN = 50_000;

export default {
  async fetch(request: Request, env: Env, ctx: unknown): Promise<Response> {
    const db = countReads(env.DB as SqlDb, { budget: REQUEST_READ_BUDGET });
    try {
      return await app.fetch(request, { ...env, DB: db }, ctx as never);
    } finally {
      if (db.rowsRead > READ_WARN) {
        console.warn(`D1 읽기 많음: ${new URL(request.url).pathname} ${db.rowsRead}행 읽음, ${db.rowsWritten}행 씀`);
      }
    }
  },
};
