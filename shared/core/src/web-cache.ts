/**
 * 받아온 응답을 브라우저에 두고, **데이터 버전이 같으면 다시 받지 않는다.**
 *
 * ## 왜 필요한가 — 왕복 한 번이 비싸다
 *
 * 한국에서 접속해도 Cloudflare 가 이 사이트를 **LA 거점**으로 보낸다. KT(AS4766)가 우리
 * 영역에 배정된 IP 대역(104.21 / 172.67)을 서울 교환센터에서 받지 않아, 트래픽이 태평양을
 * 건넜다가 돌아온다(2026-10-02 경로 추적으로 확인). 무료·Pro 어느 등급에도 대역을 고르는
 * 설정이 없어서 **우리가 못 고친다.** 그래서 왕복 한 번이 150~700ms 로 고정이다.
 *
 * 서버에는 이미 ETag 가 있어 바뀐 게 없으면 304 로 끝난다. 하지만 **304 도 왕복은 왕복이다.**
 * 달력 한 번 여는 데 드는 조회 수(세션·overview·카테고리·정기·일정·거래)만큼 곱해진다.
 *
 * 여기서는 그 꼬리표를 **화면이 직접 들고** 있는다. 시작할 때 `/api/rev` 로 버전 하나만
 * 물어보고(1행·왕복 1번), 저장해 둔 응답의 버전이 같으면 **네트워크를 아예 타지 않는다.**
 *
 * ## 틀릴 일은 없나
 *
 * 판정 기준이 서버 ETag 와 **똑같다**. 서버 꼬리표가 `rev + 날짜 + 경로 + 질의` 이고
 * 여기 열쇠도 `경로+질의` 에 같은 버전이다. 그러니 맞고 틀림은 304 를 쓰던 때와 다르지
 * 않다. 달라지는 건 왕복 횟수뿐이다.
 *
 * 뭔가 바꾸면(POST/PUT/PATCH/DELETE) 서버 rev 가 오르므로, 쓰기 뒤에는 통째로 버린다.
 *
 * ## 로그아웃하면 지운다
 *
 * 가계부 내역이 브라우저에 남는다. 401(세션 만료)과 로그아웃 때 비운다.
 */

const STORE_KEY = "hb.cache.v1";
const REV_URL = "/api/rev";
/** 한 응답이 이보다 크면 저장하지 않는다 — localStorage 는 보통 5MB 한도다 */
const MAX_ENTRY = 1_000_000;

interface Entry {
  rev: string;
  /** 꺼낼 때 한 번만 풀도록 문자열로 둔다 */
  body: string;
}

let mem: Record<string, Entry> | null = null;
let rev: string | null = null;
let pending: Promise<string | null> | null = null;

function read(): Record<string, Entry> {
  if (mem) return mem;
  try {
    mem = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, Entry>;
  } catch {
    // 사생활 보호 모드 등 localStorage 를 못 쓰는 경우. 메모리에만 둔다
    mem = {};
  }
  return mem;
}

function write(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(mem ?? {}));
  } catch {
    // 용량 초과 등. 통째로 비운다 — 캐시는 빠르자고 두는 것이라 없다고 화면이 멈추지 않는다
    mem = {};
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* 지울 수도 없으면 할 수 있는 게 없다 */
    }
  }
}

/**
 * 들고 있던 걸 전부 버린다. 쓰기 직후·로그아웃·세션 만료에 부른다.
 *
 * 버전도 함께 버려서 다음 조회가 `/api/rev` 를 새로 물어보게 한다.
 */
export function clearWebCache(): void {
  mem = {};
  rev = null;
  pending = null;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    /* 메모리 쪽은 비웠으니 그걸로 충분하다 */
  }
}

/**
 * 지금 데이터 버전을 **한 번만** 물어본다.
 *
 * 화면이 뜨기 전에 미리 불러 두면 첫 조회 때 이미 답이 와 있어서 왕복이 늘지 않는다
 * (host/src/web/main.tsx 에서 부른다).
 */
export function primeRev(): Promise<string | null> {
  if (!pending) {
    pending = fetch(REV_URL, { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? (res.json() as Promise<{ rev?: string }>) : null))
      .then((body) => (rev = body?.rev ?? null))
      // 못 물어봤으면 캐시를 안 쓴다. 느릴 뿐 틀리지는 않는다
      .catch(() => (rev = null));
  }
  return pending;
}

/** 저장해 둔 응답. 없거나 버전이 다르면 `undefined`. */
export function cacheGet(url: string): unknown {
  if (!rev) return undefined;
  const hit = read()[url];
  if (!hit || hit.rev !== rev) return undefined;
  try {
    return JSON.parse(hit.body);
  } catch {
    return undefined;
  }
}

/** 받아온 응답을 지금 버전으로 저장한다. 버전을 모르면 저장하지 않는다. */
export function cacheSet(url: string, value: unknown): void {
  if (!rev) return;
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    return;
  }
  if (body.length > MAX_ENTRY) return;
  read()[url] = { rev, body };
  write();
}
