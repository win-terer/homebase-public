/**
 * DB 계약. 운영은 Cloudflare D1 이고, 테스트·로컬 도구는 같은 모양의 better-sqlite3 어댑터(`@homebase/db/sqlite`)를 쓴다.
 * D1 이 주는 API 중 쓰는 것만 옮겨 적었다. D1Database 는 이 인터페이스를 그대로 만족한다.
 *
 * D1 무료 플랜은 요청 하나당 쿼리 수가 적게 제한된다(50). 행마다 쿼리를 날리지 말고
 * 여러 행은 JSON 한 덩어리로 넘겨 `json_each(?)` 로 한 번에 처리한다 (아래 `json`).
 */
export type SqlValue = string | number | null;

export interface RunResult {
  meta: { changes: number; last_row_id: number };
}

export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<RunResult>;
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
  /** 여러 문장을 한 트랜잭션으로 실행한다 (하나라도 실패하면 전부 되돌림) */
  batch(statements: SqlStatement[]): Promise<RunResult[]>;
}

/** 여러 행을 `json_each(?)` 에 넘길 JSON 문자열로 */
export const json = (value: unknown): string => JSON.stringify(value);

/** 큰 배열을 나눈다 (D1 한 값 크기 제한을 넘지 않게) */
export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ReadCounter {
  /** 지금까지 읽은 행 수 (D1 meta.rows_read 합계) */
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/**
 * 요청 하나가 읽을 수 있는 D1 행 수 상한 (워커가 countReads 에 넘김). 하루 한도(계정 전체 500만 행)의 3%.
 * 가장 무거운 정상 작업(카테고리 옮기기, 7,000건 기준 약 5.6만 행)이 이 절반 안에 들어오는지 예산 테스트가 확인한다.
 */
export const REQUEST_READ_BUDGET = 150_000;

/** 읽기 상한을 넘으면 던지는 오류 (운영 안전장치) */
export class ReadBudgetError extends Error {}

type Meta = { rows_read?: number; rows_written?: number; changes?: number; last_row_id?: number };

/**
 * D1 읽기·쓰기 행 수를 세는 래퍼. D1 무료 플랜은 하루 읽기 500만 행이 계정 전체 한도라,
 * 요청 하나가 상한(budget)을 넘기면 그 뒤 쿼리를 막아 한도를 다 쓰는 사고를 줄인다.
 * first() 는 meta 를 주지 않아 all() 로 대신한다 (결과는 같다).
 */
export function countReads(db: SqlDb, opts: { budget?: number } = {}): SqlDb & ReadCounter {
  const counter = { rowsRead: 0, rowsWritten: 0 };
  const guard = () => {
    if (opts.budget !== undefined && counter.rowsRead > opts.budget) {
      throw new ReadBudgetError(`D1 읽기 상한(${opts.budget.toLocaleString()}행)을 넘어서 멈췄어요 (${counter.rowsRead.toLocaleString()}행)`);
    }
  };
  const add = (meta: Meta | undefined) => {
    counter.rowsRead += meta?.rows_read ?? 0;
    // D1 은 rows_written, 테스트용 sqlite 어댑터는 changes 를 준다 — 둘 다 '뭔가 썼다' 는 신호다.
    // 이 값이 0 인지 아닌지로 데이터 버전을 올릴지 정하므로 어느 쪽이든 잡아야 한다.
    counter.rowsWritten += meta?.rows_written ?? meta?.changes ?? 0;
  };
  const wrap = (stmt: SqlStatement): SqlStatement & { inner: SqlStatement } => ({
    inner: stmt,
    bind: (...values) => wrap(stmt.bind(...values)),
    async first<T>() {
      guard();
      const r = (await stmt.all<T>()) as { results: T[]; meta?: Meta };
      add(r.meta);
      return r.results[0] ?? null;
    },
    async all<T>() {
      guard();
      const r = (await stmt.all<T>()) as { results: T[]; meta?: Meta };
      add(r.meta);
      return r;
    },
    async run() {
      guard();
      const r = (await stmt.run()) as RunResult & { meta: Meta };
      add(r.meta);
      return r;
    },
  });
  return {
    get rowsRead() {
      return counter.rowsRead;
    },
    get rowsWritten() {
      return counter.rowsWritten;
    },
    prepare: (sql) => wrap(db.prepare(sql)),
    async batch(statements) {
      guard();
      const results = (await db.batch(statements.map((s) => (s as ReturnType<typeof wrap>).inner ?? s))) as (RunResult & { meta: Meta })[];
      for (const r of results) add(r.meta);
      return results;
    },
  };
}
