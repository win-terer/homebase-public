import { cacheGet, cacheSet, clearWebCache, primeRev } from "@homebase/core/web-cache";
import type { ImportPayload } from "../importers/types.ts";

export interface ImportSummary {
  source: { id: string; label: string };
  period: { from: string; to: string } | null;
  total: number;
  new: number;
  newByKind: { expense: number; income: number; transfer: number };
  duplicates: number;
  review: number;
  excluded: Record<string, number>;
  skipped: { row: string; reason: string }[];
  inserted?: number;
  /** 엑셀이 덮으면서 짝을 못 찾아 날짜 상세에 남겨 둔 앱알림 메모 수 (저장할 때만) */
  lostMemos?: number;
  batchId?: number;
  /** 뱅크샐러드 첫 시트에서 읽은 재무 스냅샷 (대출·자산 개수) */
  snapshot?: { loans: number; assets: number; investments: number; creditScore: number | null } | null;
}

/**
 * 가져오기 한 번의 기록 (`ledger_import_batches`). 화면에서 올리든 집 맥북의 자동 가져오기가
 * 올리든 한 줄씩 남는다 — 언제 무엇이 들어왔는지 되짚는 유일한 흔적이다.
 */
/** 간편결제 중복 한 짝 — `pay` 를 지우고 `card` 를 남긴다 (서버 duplicates.ts) */
export interface DupePair {
  pay: { id: number; date: string; time: string | null; merchant: string; amount: number; paymentMethod: string | null };
  card: { id: number; date: string; time: string | null; merchant: string; amount: number; paymentMethod: string | null };
}

export interface ImportBatch {
  id: number;
  source: string;
  fileName: string;
  periodFrom: string | null;
  periodTo: string | null;
  totalRows: number;
  /** 실제로 새로 들어간 건수 */
  inserted: number;
  duplicates: number;
  excluded: number;
  skipped: number;
  importedAt: string;
}

/** 엑셀이 덮을 때 어느 결제인지 못 정해 남겨 둔 앱알림 메모 — 날짜 상세에서 사람이 붙인다 */
export interface LostMemo {
  /** 설정 키 (지울 때) */
  key: string;
  date: string;
  time: string | null;
  amount: number;
  /** 알림에 찍힌 가맹점 (결제대행사 이름일 때가 많다) */
  merchant: string;
  memo: string | null;
  categoryId: number | null;
  /** 그 앱알림 줄에 붙어 있던 사진 수 (사진은 `lost:<key>` 로 옮겨 둠, server/imports.ts) */
  photos?: number;
}

/** 일정 앱이 펼쳐 준 하루 일정 한 줄 */
export interface ScheduleItem {
  id: number;
  title: string;
  /** "종일" / "14:00–15:00" 등 */
  time: string;
  /** 카테고리 색 (hb-c-<색>) */
  color: string;
  location: string | null;
}

/** 갈려 들어온 결제 한 줄 (web/split-pay.ts) */
export interface SplitPart {
  id: number;
  amount: number;
  paymentMethod: string | null;
}

export interface Transaction {
  id: number;
  kind: "expense" | "income" | "transfer";
  date: string;
  time: string | null;
  /** 보여줄 가맹점 이름 (같은 곳의 다른 표기를 묶은 이름) */
  merchant: string;
  /** 소스에 찍힌 원래 이름 */
  rawMerchant?: string;
  /** 한 줄 메모 (달력에 가맹점 대신 보임) */
  memo: string | null;
  /** 상세 메모 (주문 품목 등, 여러 줄. 날짜 상세에서만 보임) */
  note: string | null;
  /** 원. 나간 돈 음수, 들어온 돈 양수 */
  amount: number;
  paymentMethod: string | null;
  categoryId: number | null;
  category: string | null;
  /** 상위 카테고리 (없으면 category 와 같음). 통계에서 묶는 기준 */
  categoryGroup: string | null;
  settlesId: number | null;
  /** 현금영수증이 발급된 거래 (홈택스 현금영수증과 연결됨) */
  cashReceipt?: boolean;
  /** 메모 낱말로 붙은 태그 (server/tags.ts). 없으면 칸 자체가 안 온다 */
  tags?: string[];
  /**
   * 한 번 결제한 것이 여러 줄로 갈려 들어왔을 때, 그 줄들(자기 자신 포함). **화면에서 붙인다**
   * — 서버는 보내지 않는다(`web/split-pay.ts` 의 `mergeSplits`). `amount` 는 이미 합친 값이다.
   */
  splitParts?: readonly SplitPart[];
  /**
   * 폰 알림으로 만든 **임시** 거래. 뱅샐 엑셀이 그 기간을 덮으면 사라지고 확정 데이터로 바뀐다.
   * 카테고리가 없고 가맹점 이름도 결제대행사로 올 수 있다(네이버페이 → "네이버파이낸셜(주)").
   */
  provisional?: boolean;
}

export interface CashReceiptPreview {
  total: number;
  amount: number;
  duplicates: number;
  existing: number;
  added: number;
  cancelled: number;
  skipped: { row: string; reason: string }[];
  rows: {
    approvalNo: string;
    date: string;
    time: string | null;
    merchant: string;
    amount: number;
    outcome: "existing" | "added" | "cancelled";
    match: { id: number; date: string; merchant: string; paymentMethod: string | null } | null;
  }[];
  stored?: number;
}

export type RuleAction = "exclude" | "transfer" | "expense" | "income";

export interface ReviewGroup {
  counterparty: string;
  names: string[];
  count: number;
  total: number;
  from: string;
  to: string;
  rows: { id: number; date: string; time: string | null; merchant: string; amount: number; paymentMethod: string | null }[];
}

/** 메모를 저장하면 돌아오는 값. 태그는 메모에서 뽑으므로 메모와 함께 바뀐다 */
export interface SavedMemo {
  memo: string | null;
  note: string | null;
  tags?: string[];
}

/** 메모 저장 결과를 거래 한 건에 반영한다 (태그도 같이) */
export function withSavedMemo<T extends Transaction>(tx: T, saved: SavedMemo): T {
  return { ...tx, memo: saved.memo, note: saved.note, ...(saved.tags ? { tags: saved.tags } : {}) };
}

/** 메모 낱말 → 태그 이름 (server/tags.ts) */
export interface TagRule {
  word: string;
  tag: string;
}

export interface CategoryOption {
  id: number;
  name: string;
  parentId: number | null;
  label: string;
}

/** 관리 화면용 — 카테고리마다 걸려 있는 거래·자동 분류 규칙 수 (server/category-admin.ts) */
export interface CategoryUsage {
  id: number;
  name: string;
  parentId: number | null;
  sort: number;
  transactions: number;
  rules: number;
}

/**
 * 조회는 들고 있던 걸 먼저 본다 (shared/core/src/web-cache.ts 참고).
 *
 * 이 사이트는 한국에서 접속해도 LA 거점으로 붙어서 왕복 한 번이 150~700ms 다. 바뀐 게
 * 없으면 서버가 304 로 끝내 주지만 **304 도 왕복은 왕복**이라, 화면 하나에 드는 조회 수만큼
 * 곱해진다. 버전 하나만 확인하고 나머지는 네트워크를 건너뛴다.
 */
async function request<T>(url: string, init?: RequestInit, opts: { fresh?: boolean } = {}): Promise<T> {
  // fresh: 데이터 버전이 그대로여도 답이 달라지는 조회 (자동 가져오기 생존 보고는 버전을 안 올린다).
  // 들고 있던 것도, 브라우저 HTTP 캐시(If-None-Match → 304)도 안 쓴다
  const isRead = (!init?.method || init.method === "GET") && !opts.fresh;
  if (isRead) {
    await primeRev();
    const hit = cacheGet(url);
    if (hit !== undefined) return hit as T;
  }
  const res = await fetch(url, opts.fresh ? { ...init, cache: "no-store" } : init);
  if (res.status === 401) {
    // 로그인이 풀렸으면 로그인 화면으로 (돌아올 곳 기억). 남의 브라우저에 내역을 남기지 않는다
    clearWebCache();
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    throw new Error("로그인이 필요해요");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `요청 실패 (${res.status})`);
  if (opts.fresh) {
    /* 캐시에 넣지도, 비우지도 않는다 */
  } else if (isRead) {
    cacheSet(url, body);
  } else {
    // 뭔가 바꿨으면 서버 버전이 올라간다 — 들고 있던 건 전부 버리고, 다음 조회가 기다리지
    // 않도록 새 버전을 미리 물어본다 (화면이 곧 다시 조회하므로 그 요청과 겹쳐 돈다)
    clearWebCache();
    void primeRev();
  }
  return body as T;
}

export interface Loan {
  kind: string;
  institution: string;
  product: string;
  principal: number;
  balance: number;
  rate: number;
  start: string | null;
  end: string | null;
}

export interface Snapshot {
  asOf: string;
  creditScore: number | null;
  loans: Loan[];
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** POST 말고 다른 메서드로 보낼 때 (json 은 POST 전용) */
const send = <T>(url: string, method: string, body?: unknown) =>
  request<T>(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** 집 맥북 ledger-sync 의 마지막 보고 (server/notify-status.ts). 보고가 한 번도 없으면 null */
export interface SyncStatus {
  lastOkAt: string | null;
  lastFailAt: string | null;
  failStreak: number;
  lastStep: string | null;
  lastError: string | null;
  lastReportAt: string;
}

/** 폰 알림 원문 한 줄 (앞 160자만) */
export interface RecentNotification {
  id: number;
  sentAt: string | null;
  receivedAt: string;
  app: string | null;
  title: string | null;
  subtitle: string | null;
  excerpt: string | null;
  /** 거래로 읽어 들였는지 */
  parsed: boolean;
}

export interface NotifyOverview {
  status: { lastAt: string | null; lastApp: string | null; pending: number };
  sync: SyncStatus | null;
  /** 폰 알림으로 만든 임시 거래, 최신이 먼저 (최대 200) */
  provisional: Transaction[];
  recent: RecentNotification[];
}


/** 메일 가져오기 설정 — 화면이 받는 모양 (비밀값은 들어 있는지만) */
export interface MailConfigView {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  mailbox: string;
  sender: string;
  everyMinutes: number;
  hasPassword: boolean;
  hasZipPassword: boolean;
  hasZipPassword2: boolean;
  /** 워커 Secret SETTINGS_KEY 가 있는지. 없으면 비밀값을 저장할 수 없다 */
  canStoreSecrets: boolean;
  /** 열쇠가 바뀌어 예전 비밀값을 못 읽는 상태 */
  secretsUnreadable: boolean;
}

/** 보낼 때 — 비밀값은 **바꿀 때만** 넣는다 (빈 문자열이면 지우기) */
export type MailConfigInput = Omit<MailConfigView, "hasPassword" | "hasZipPassword" | "hasZipPassword2" | "canStoreSecrets" | "secretsUnreadable"> &
  Partial<{ password: string; zipPassword: string; zipPassword2: string }>;

export const ledgerApi = {
  overview: () => request<{ review: number }>("/api/ledger"),
  /** 알림 화면. 자동 가져오기 보고는 데이터 버전을 안 올리므로 캐시 없이 매번 읽는다 */
  notifyOverview: () => request<NotifyOverview>("/api/ledger/notify/overview", undefined, { fresh: true }),

  transactions: (from: string, to: string) =>
    request<Transaction[]>(`/api/ledger/transactions?from=${from}&to=${to}`),

  /** 한 줄 메모나 상세 메모 중 보낸 것만 바꾼다 */
  setMemo: (id: number, change: { memo?: string | null; note?: string | null }) =>
    request<SavedMemo>(`/api/ledger/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    }),

  /** 사용자가 직접 고르지 않은 같은 가게 결제 중 카테고리가 다른 것 수 */
  similarCategory: (merchant: string, amount: number, categoryId: number) =>
    request<{ sameAmount: number; sameMerchant: number }>(
      `/api/ledger/categories/similar?merchant=${encodeURIComponent(merchant)}&amount=${amount}&categoryId=${categoryId}`,
    ),

  /** 같은 가게·같은 금액 결제의 카테고리를 한 번에 */
  applyCategory: (body: { merchant: string; amount: number | null; categoryId: number; remember: boolean }) =>
    request<{ updated: number }>("/api/ledger/categories/apply", json(body)),

  /** 정기 결제 (같은 이름·같은 간격으로 나간 돈) */
  recurring: () => request<import("./recurring.ts").RecurringResult>("/api/ledger/recurring"),
  /** 일정 앱의 날짜별 일정 (가계부 달력에 흐리게) */
  schedule: (from: string, to: string) => request<{ days: Record<string, ScheduleItem[]> }>(`/api/calendar/days?from=${from}&to=${to}`),

  /** 지금까지 쓴 메모 (자동완성용) */
  memos: () => request<import("./memo-suggest.ts").MemoUse[]>("/api/ledger/memos"),
  searchTerms: () => request<Omit<import("./search-suggest.ts").SearchTerms, "categories">>("/api/ledger/search/terms"),

  /** 메모가 없는 같은 가게(원래 이름) 결제 수 */
  similarWithoutMemo: (merchant: string, amount: number) =>
    request<{ sameAmount: number; sameMerchant: number }>(`/api/ledger/memos/similar?merchant=${encodeURIComponent(merchant)}&amount=${amount}`),

  /** 메모 없는 같은 가게(amount 가 있으면 같은 금액) 결제에 한 번에 메모 넣기 */
  applyMemo: (body: { merchant: string; amount: number | null; memo: string; remember: boolean }) =>
    request<{ updated: number }>("/api/ledger/memos/apply", json(body)),

  /** 가맹점 이름·메모·상세 메모·금액에서 찾기 (최근 것부터 200건) */
  /** `cancels` 는 **화면에 안 보이는 환불 줄** — 찾은 결제가 취소된 것인지 짝을 맞추는 데만 쓴다 */
  search: (q: string) => request<{ results: Transaction[]; more: boolean; cancels: Transaction[] }>(`/api/ledger/search?q=${encodeURIComponent(q)}`),

  setCategory: (id: number, choice: { categoryId: number | null } | { newCategory: string }) =>
    request<{ categoryId: number | null }>(`/api/ledger/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(choice),
    }),

  review: () => request<ReviewGroup[]>("/api/ledger/review"),

  categories: () => request<CategoryOption[]>("/api/ledger/categories"),

  /** 카테고리 관리 화면. 고치는 쪽은 모두 바뀐 목록을 그대로 돌려준다 (다시 조회하지 않게) */
  categoryUsage: () => request<CategoryUsage[]>("/api/ledger/categories/manage"),
  renameCategory: (id: number, name: string) => send<{ categories: CategoryUsage[] }>(`/api/ledger/categories/${id}`, "PATCH", { name }),
  mergeCategory: (id: number, into: number) => send<{ moved: number; categories: CategoryUsage[] }>(`/api/ledger/categories/${id}/merge`, "POST", { into }),
  deleteCategory: (id: number) => send<{ categories: CategoryUsage[] }>(`/api/ledger/categories/${id}`, "DELETE"),
  tagRules: () => request<{ rules: TagRule[] }>("/api/ledger/tags"),
  addTagRule: (word: string, tag: string) => send<{ rules: TagRule[] }>("/api/ledger/tags", "POST", { word, tag }),
  removeTagRule: (word: string) => send<{ rules: TagRule[] }>(`/api/ledger/tags/${encodeURIComponent(word)}`, "DELETE"),

  orderCategories: (parentId: number | null, ids: number[]) => send<{ categories: CategoryUsage[] }>("/api/ledger/categories/order", "POST", { parentId, ids }),

  decide: (body: { counterparty: string; action: RuleAction; categoryId?: number | null; newCategory?: string }) =>
    request<{ affected: number }>("/api/ledger/review/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

  importCashReceipts: (data: { receipts: unknown[]; skipped: unknown[] }, commit: boolean) =>
    request<CashReceiptPreview>(commit ? "/api/ledger/cash-receipts" : "/api/ledger/cash-receipts/preview", json(data)),

  cashReceiptSummary: (year: string) =>
    request<{ count: number; total: number; culture: number }>(`/api/ledger/cash-receipts/summary?year=${year}`),

  latestSnapshot: () => request<Snapshot | null>("/api/ledger/snapshot/latest"),

  settings: () => request<Record<string, string>>("/api/ledger/settings"),
  /** 엑셀이 덮으면서 짝을 못 찾은 앱알림 메모 (서버 imports.ts 의 lostMemoKey). 날짜순 */
  lostMemos: async (): Promise<LostMemo[]> => {
    const all = await request<Record<string, string>>("/api/ledger/settings");
    const out: LostMemo[] = [];
    for (const [key, value] of Object.entries(all)) {
      const m = key.match(/^notify\.lost\.(\d{4}-\d{2}-\d{2})\.(-?\d+)\.(.+)$/);
      if (!m) continue;
      try {
        const v = JSON.parse(value) as { memo: string | null; categoryId: number | null; merchant: string; photos?: number };
        out.push({ key, date: m[1]!, amount: Number(m[2]), time: m[3] === "-" ? null : m[3]!, ...v });
      } catch {
        /* 손으로 망가뜨린 값은 건너뛴다 */
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
  },

  /**
   * 가져온 기록 20건. **캐시를 거치지 않는다**(`fresh`) — 자동 가져오기는 브라우저 모르게
   * 올리므로, 들고 있던 걸 보여 주면 "마지막 가져오기" 가 옛날에 멈춰 있는 것처럼 보인다.
   */
  /** 간편결제 중복 — 네이버페이로 카드를 긁어 두 줄로 들어온 것 */
  /** 메일에서 엑셀 자동으로 가져오기 설정 (server/mail-config.ts). 비밀값은 내려오지 않는다 */
  mailConfig: () => request<MailConfigView>("/api/ledger/mail-config", undefined, { fresh: true }),
  saveMailConfig: (body: MailConfigInput) =>
    request<MailConfigView>("/api/ledger/mail-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  /** 설치할 때 한 번 쓰는 연결 코드 (10분) */
  mailLink: () => request<{ code: string; expiresAt: string }>("/api/ledger/mail-config/link", { method: "POST" }),

  duplicates: () => request<{ pairs: DupePair[] }>("/api/ledger/duplicates", undefined, { fresh: true }),
  removeDuplicates: (ids: number[]) =>
    request<{ removed: number }>("/api/ledger/duplicates/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),

  importHistory: () => request<ImportBatch[]>("/api/ledger/imports", undefined, { fresh: true }),

  setSetting: (key: string, value: string | null) =>
    request<{ ok: true }>("/api/ledger/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    }),

  /**
   * 가져오기 미리보기·저장. 무료 플랜 CPU 제한(요청당 10ms) 때문에 500건씩 나눠 보내고 결과를 합친다.
   * 저장은 첫 조각이 만든 가져오기 기록(batchId)에 나머지 조각을 이어 붙인다.
   */
  async importPayload(payload: ImportPayload, commit: boolean): Promise<ImportSummary> {
    const url = commit ? "/api/ledger/imports" : "/api/ledger/imports/preview";
    const parts = importChunks(payload.rows, IMPORT_CHUNK);
    const asOf = payload.rows.reduce((max, r) => (r.date > max ? r.date : max), "") || undefined;
    let merged: ImportSummary | null = null;
    for (const [i, rows] of parts.entries()) {
      const last = i === parts.length - 1;
      const part = await request<ImportSummary>(
        url,
        json({
          ...payload,
          rows,
          skipped: i === 0 ? payload.skipped : [],
          snapshot: last ? payload.snapshot : null,
          ...(asOf ? { asOf } : {}),
          ...(merged?.batchId ? { batchId: merged.batchId } : {}),
        }),
      );
      merged = mergeSummaries(merged, part);
    }
    return merged!;
  },
};

const IMPORT_CHUNK = 500;

/** 빈 파일이어도 요청은 한 번 보낸다 */
export function importChunks<T>(items: T[], size: number): T[][] {
  if (!items.length) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 나눠 보낸 가져오기 결과를 하나로 합친다 */
export function mergeSummaries(a: ImportSummary | null, b: ImportSummary): ImportSummary {
  if (!a) return b;
  const excluded = { ...a.excluded };
  for (const [k, n] of Object.entries(b.excluded)) excluded[k] = (excluded[k] ?? 0) + n;
  const period =
    a.period && b.period
      ? { from: a.period.from < b.period.from ? a.period.from : b.period.from, to: a.period.to > b.period.to ? a.period.to : b.period.to }
      : (a.period ?? b.period);
  return {
    ...a,
    period,
    total: a.total + b.total,
    new: a.new + b.new,
    newByKind: {
      expense: a.newByKind.expense + b.newByKind.expense,
      income: a.newByKind.income + b.newByKind.income,
      transfer: a.newByKind.transfer + b.newByKind.transfer,
    },
    duplicates: a.duplicates + b.duplicates,
    review: a.review + b.review,
    excluded,
    skipped: [...a.skipped, ...b.skipped],
    ...(a.inserted !== undefined || b.inserted !== undefined ? { inserted: (a.inserted ?? 0) + (b.inserted ?? 0) } : {}),
    ...(a.lostMemos !== undefined || b.lostMemos !== undefined ? { lostMemos: (a.lostMemos ?? 0) + (b.lostMemos ?? 0) } : {}),
    snapshot: b.snapshot ?? a.snapshot ?? null,
    ...(a.batchId ?? b.batchId ? { batchId: a.batchId ?? b.batchId } : {}),
  };
}

export const won = (n: number) => n.toLocaleString("ko-KR");

/** 좁은 칸용 짧은 금액: 1만 이상은 "368.3만" */
export const shortWon = (n: number) =>
  n >= 10000 ? `${(Math.round(n / 1000) / 10).toLocaleString("ko-KR")}만` : won(n);

/**
 * 달력 칸의 한 줄 금액: 만 원 단위 소수 둘째 자리까지, 단위 글자 없이. 17,500 → 1.75, 450,000 → 45, 3,700 → 0.37.
 * 칸이 좁아 숫자가 길면 가게 이름이 두세 글자만 남는다 — 그날 합계는 원 단위 그대로 두고 줄만 줄인다.
 */
/** 달력이 좁을 때 쓰는 시각 — `07:48` 대신 `7시`. 분까지 보일 자리가 없고, 몇 시쯤인지면 충분하다 */
export const hourLabel = (time: string) => `${Number(time.slice(0, 2))}시`;

export const manWon = (n: number) => {
  const v = Math.round(n / 100) / 100;
  return v.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
};

/** 좁은 칸용 아주 짧은 금액: 12,300 → 1.2만, 8,900 → 8.9천, 500 → 500 */
export const compactWon = (n: number) =>
  n >= 10000 ? shortWon(n) : n >= 1000 ? `${(Math.round(n / 100) / 10).toLocaleString("ko-KR")}천` : won(n);

/** 지출 합계 (취소·환불은 양수라서 자동으로 상쇄된다) */
export const spendOf = (txs: Transaction[]) =>
  txs.filter((t) => t.kind === "expense").reduce((sum, t) => sum - t.amount, 0);

/**
 * 그날 들어온 돈과 나간 돈을 따로 계산한다.
 * 들어온 돈: 수입 + 받은 이체. 나간 돈: 지출(취소·환불로 상쇄) + 보낸 이체.
 * 환불이 결제보다 많은 날은 남는 만큼 들어온 돈으로 친다.
 */
export function flowOf(txs: Transaction[]): { in: number; out: number } {
  let inflow = 0;
  let outflow = spendOf(txs);
  for (const t of txs) {
    if (t.kind === "expense") continue;
    if (t.amount > 0) inflow += t.amount;
    else outflow -= t.amount;
  }
  if (outflow < 0) {
    inflow -= outflow;
    outflow = 0;
  }
  return { in: inflow, out: outflow };
}

/** 달력·목록에 보일 금액과 색 */
export function amountView(tx: Transaction): { text: string; sign: "" | "+" | "-"; tone: "spend" | "refund" | "in" | "out" } {
  if (tx.kind === "expense") {
    return tx.amount <= 0 ? { text: won(-tx.amount), sign: "", tone: "spend" } : { text: `+${won(tx.amount)}`, sign: "+", tone: "refund" };
  }
  return tx.amount >= 0 ? { text: `+${won(tx.amount)}`, sign: "+", tone: "in" } : { text: `-${won(-tx.amount)}`, sign: "-", tone: "out" };
}

/**
 * 결제했다가 **전액 취소한 짝** 찾기: 같은 (원래) 가게·같은 금액의 지출과 환불.
 *
 * 화면은 원래 결제에 **취소선만** 긋고 환불 줄은 숨긴다. 합계에서도 **둘 다 뺀다** — 취소된
 * 결제는 쓴 돈이 아니고, 환불만 빼고 결제를 남기면 달이 통째로 틀어진다.
 *
 * **며칠 걸쳐 들어온 것도 묶는다**(2026-10-06). 카드 취소는 그날 바로 안 들어오고 이틀씩
 * 밀려서 들어온다 — 10/1 에 결제하고 10/3 에 환불이 찍히면, 10/3 칸에 `+19,400` 한 줄만
 * 덩그러니 남아 무슨 돈인지 알 수가 없었다(사용자 지적). 그래서 **하루치가 아니라 보고 있는
 * 기간 전체**를 한 번에 넘겨 짝을 맞춘다.
 *
 * 환불 하나에 결제 하나(1:1). 환불 **이전**의 가장 가까운 결제부터 가져간다 — 같은 가게에서
 * 같은 금액을 여러 번 결제한 날이 실제로 있어서(기차표), 먼저 쓴 것이 먼저 짝이 돼야 한다.
 */
/** 환불이 결제보다 이만큼 늦게까지 들어와도 같은 건으로 본다 — 카드 취소는 이틀씩 밀린다 */
export const CANCEL_WITHIN_DAYS = 7;

export function pairCancels(txs: Transaction[], withinDays = CANCEL_WITHIN_DAYS): { cancelled: Set<number>; absorbed: Set<number> } {
  const cancelled = new Set<number>();
  const absorbed = new Set<number>();
  const shopOf = (t: Transaction) => t.rawMerchant ?? t.merchant;
  const keyOf = (t: Transaction) => `${shopOf(t)}|${Math.abs(t.amount)}`;
  const stamp = (t: Transaction) => `${t.date} ${t.time ?? "99"}`;
  const days = (a: string, b: string) => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  const near = (refund: Transaction, paid: Transaction) => {
    const gap = days(refund.date, paid.date);
    return gap >= 0 && gap <= withinDays;
  };
  // 환불도 시간 순으로 봐야 어느 결제를 가져갈지가 입력 순서에 흔들리지 않는다
  const refunds = txs.filter((t) => t.kind === "expense" && t.amount > 0).sort((a, b) => stamp(a).localeCompare(stamp(b)));
  for (const refund of refunds) {
    const key = keyOf(refund);
    const candidates = txs.filter((t) => t.kind === "expense" && t.amount < 0 && !cancelled.has(t.id) && keyOf(t) === key && near(refund, t));
    if (!candidates.length) continue;
    const at = stamp(refund);
    const before = candidates.filter((t) => stamp(t) <= at).sort((a, b) => stamp(b).localeCompare(stamp(a)));
    const original = before[0] ?? candidates[0]!;
    cancelled.add(original.id);
    absorbed.add(refund.id);
  }

  /**
   * **쪼개 들어온 환불**: 결제 한 건을 취소했는데 금액이 반씩 두 줄로 돌아온 일이 실제로
   * 있었다(기차표를 2인으로 끊고 1인씩 환불). 금액이 똑같은 것끼리만 보면 영영 안 묶인다.
   *
   * 그래서 남은 환불을 **같은 가게끼리 모아 합이 결제 하나와 맞는지** 본다. 아무 조합이나
   * 뒤지지 않는다 — 시간 순으로 앞에서부터 더해 가다 딱 맞으면 거기서 끊는다(두 줄 이상).
   * 넘어서면 포기한다. 같은 가게·같은 기간·딱 떨어지는 합, 셋이 겹칠 확률은 낮다.
   */
  for (const shop of new Set(refunds.filter((r) => !absorbed.has(r.id)).map(shopOf))) {
    const left = refunds.filter((r) => !absorbed.has(r.id) && shopOf(r) === shop);
    const paid = txs
      .filter((t) => t.kind === "expense" && t.amount < 0 && !cancelled.has(t.id) && shopOf(t) === shop)
      .sort((a, b) => stamp(b).localeCompare(stamp(a)));
    for (const original of paid) {
      const want = -original.amount;
      const parts: Transaction[] = [];
      let sum = 0;
      for (const r of left) {
        if (absorbed.has(r.id) || !near(r, original)) continue;
        if (sum + r.amount > want) continue;
        parts.push(r);
        sum += r.amount;
        if (sum === want) break;
      }
      if (sum === want && parts.length > 1) {
        cancelled.add(original.id);
        for (const r of parts) absorbed.add(r.id);
      }
    }
  }
  return { cancelled, absorbed };
}

/** 이 금액 미만의 수입(출금 리워드·이자 등)은 한 줄 합계로만 보여준다 */
export const SMALL_INCOME_LIMIT = 1000;

export function splitSmallIncome(txs: Transaction[]) {
  const isSmall = (t: Transaction) => t.kind === "income" && t.amount > 0 && t.amount < SMALL_INCOME_LIMIT;
  const small = txs.filter(isSmall);
  return {
    main: txs.filter((t) => !isSmall(t)),
    small,
    smallTotal: small.reduce((sum, t) => sum + t.amount, 0),
  };
}

/** 달력에 보일 이름: 메모가 있으면 메모 우선 */
export const labelOf = (tx: Transaction) => tx.memo || tx.merchant;
