/**
 * 받아 둔 xlsx 를 파싱해 homebase 로 올린다. (2단계 — 1단계는 fetch_mail.py)
 *
 * **파싱을 새로 짜지 않는다.** homebase 저장소의 `prepare-import.ts` 를 그대로 불러 쓴다.
 * 새로 짜면 화면으로 올릴 때와 결과가 어긋나기 시작한다 — 중복 키·건너뛴 행·스냅샷까지
 * 똑같아야 한다. Node 의 타입 스트리핑으로 TS 를 그대로 실행한다.
 *
 * 전송 규약은 화면(`web/api.ts`)과 같다:
 *   - 무료 플랜 CPU 10ms 때문에 **500건씩** 나눠 보낸다
 *   - 첫 조각이 만든 batchId 에 나머지를 이어 붙인다
 *   - skipped 는 첫 조각에만, snapshot 은 마지막 조각에만
 *
 * 인증은 세션이 아니라 가져오기 전용 키(X-Import-Token)다 — 스크립트는 OTP 를 칠 수 없다.
 * 그 키로는 가져오기 세 경로 말고 아무것도 못 한다(homebase auth.ts 의 IMPORT_PATHS).
 * 주소와 열쇠는 설치할 때 받아 둔 설정에서 읽는다 (setup.sh → ~/.homebase-sync/config.json).
 *
 * 사용: node --experimental-strip-types send.ts <xlsx 경로> [--dry] [--all]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
/**
 * 파서는 **이 폴더 안의 번들**을 쓴다 (`prepare-import.mjs`).
 *
 * 예전에는 `~/Documents` 안의 저장소를 절대 경로로 import 했는데, **launchd 가 띄운
 * 프로세스는 `~/Documents` 를 읽지 못한다**(macOS 개인정보 보호). 실패로 끝나면 차라리
 * 나은데 `open()` 에서 **영원히 멈춘다** — 2026-10-03 에 실제로 20분 넘게 묶였고,
 * launchd 는 겹쳐 돌리지 않으므로 그 뒤 실행이 전부 건너뛰어졌다. 손으로 돌리면 멀쩡해서
 * 더 찾기 어렵다(터미널에서는 TCC 가 통과된다).
 *
 * 그래서 실행 중에는 `~/Documents` 를 **아예 건드리지 않는다.** 저장소 파서가 바뀌면
 * `setup.sh` 를 다시 돌려 번들을 새로 만든다(사람이 터미널에서 돌리므로 TCC 에 안 걸린다).
 */
import { prepareImport } from "./prepare-import.mjs";

const CHUNK = 500;

/**
 * 설치할 때 받아 둔 설정 (`~/.homebase-sync/config.json`, `setup.sh` 가 적는다).
 * 주소도 열쇠도 여기서 온다 — 이 파일에는 아무것도 박혀 있지 않다.
 */
const DIR = process.env.HOMEBASE_SYNC_DIR || join(homedir(), ".homebase-sync");
function config(): { base: string; importToken: string } {
  try {
    const cfg = JSON.parse(readFileSync(join(DIR, "config.json"), "utf8")) as { base?: string; importToken?: string };
    if (!cfg.base || !cfg.importToken) throw new Error("base 또는 importToken 이 비어 있어요");
    return { base: cfg.base.replace(/\/$/, ""), importToken: cfg.importToken };
  } catch (e) {
    console.error(
      `설정을 읽지 못했어요 (${join(DIR, "config.json")}): ${(e as Error).message}\n` +
        "homebase 의 [가져오기] 탭에서 '연결 코드 받기' 를 누른 뒤 ./setup.sh <주소> <코드> 를 한 번 실행하세요.",
    );
    process.exit(1);
  }
}
const { base: BASE, importToken: TOKEN } = config();

const path = process.argv[2];
const dry = process.argv.includes("--dry");
const all = process.argv.includes("--all");

/**
 * 뱅샐은 **1년치로만** 내보내 준다. 그걸 매번 통째로 올리면 느리고(왕복마다 LA 왕복)
 * D1 읽기도 많이 먹는다. 그래서 **올리기 직전에 자른다.**
 *
 * 자르는 기준은 고정 기간이 아니라 **마지막으로 올린 날짜**다. 고정(예: 최근 30일)으로 하면
 * 그보다 오래 안 올렸을 때 조용히 빵꾸가 난다. 마지막 날짜 기준이면 몇 달 만에 올려도 다 들어온다.
 *
 * 거기서 14일을 더 뒤로 잡는다 — 카드 취소·가맹점 이름 정정처럼 **지난 기록이 나중에 바뀌는**
 * 경우가 있어서다. 중복은 서버가 거르므로 겹쳐 보내도 손해가 없다.
 *
 * `--all` 이면 자르지 않는다 (처음 채울 때나 과거를 다시 맞출 때).
 */
const THROUGH = join(DIR, "through");
const OVERLAP_DAYS = 14;

function windowStart(): string | null {
  if (all) return null;
  let last: string;
  try {
    last = readFileSync(THROUGH, "utf8").trim();
  } catch {
    return null; // 처음이면 전부 올린다
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) return null;
  const d = new Date(`${last}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - OVERLAP_DAYS);
  return d.toISOString().slice(0, 10);
}
if (!path) {
  console.error("사용: node --experimental-strip-types send.ts <xlsx 경로> [--dry] [--all]");
  process.exit(1);
}

const bytes = readFileSync(path);
const payload = await prepareImport(new File([bytes], basename(path)));
const parsed = payload.rows.length;
// **파싱한 뒤에** 자른다. 중복 제거 키는 파일 전체를 보고 매겨지므로(같은 가게·같은 금액 두 번
// 결제의 순번), 자르고 파싱하면 전체를 올릴 때와 키가 달라져 중복이 걸러지지 않는다.
const from = windowStart();
if (from) payload.rows = payload.rows.filter((r) => r.date >= from);
console.error(
  `파싱: ${parsed.toLocaleString()}건 · 건너뜀 ${payload.skipped.length}건 · 스냅샷 ${payload.snapshot ? "있음" : "없음"}` +
    (from ? `\n보낼 범위: ${from} 이후 ${payload.rows.length.toLocaleString()}건 (${(parsed - payload.rows.length).toLocaleString()}건은 이미 올린 기간)` : "\n보낼 범위: 전체"),
);

const url = `${BASE}/api/ledger/imports${dry ? "/preview" : ""}`;
// 날짜 중 가장 큰 값 — 서버가 '언제까지의 내보내기인지' 판단하는 데 쓴다(화면과 동일)
const asOf = payload.rows.reduce((max, r) => (r.date > max ? r.date : max), "") || undefined;

const parts: (typeof payload.rows)[] = [];
for (let i = 0; i < payload.rows.length; i += CHUNK) parts.push(payload.rows.slice(i, i + CHUNK));
if (!parts.length) parts.push([]); // 빈 파일이어도 한 번은 보낸다

// 서버가 돌려주는 요약(ImportSummary)의 필드 이름을 그대로 쓴다 — new / duplicates / review
let batchId: string | undefined;
let total = 0;
let fresh = 0;
let dup = 0;
let review = 0;
let period: { from: string; to: string } | null = null;

for (const [i, rows] of parts.entries()) {
  const last = i === parts.length - 1;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // sameOrigin 미들웨어가 POST 에 Origin 을 요구한다 (브라우저용 CSRF 방어)
      origin: BASE,
      "X-Import-Token": TOKEN,
    },
    // 거점이 LA 라 느릴 수는 있어도 2분이면 충분하다. 제한이 없으면 한 조각이 막힐 때
    // 프로세스가 영영 안 끝나고, launchd 는 겹쳐 돌리지 않으므로 동기화가 통째로 멈춘다
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      ...payload,
      rows,
      skipped: i === 0 ? payload.skipped : [],
      snapshot: last ? payload.snapshot : null,
      ...(asOf ? { asOf } : {}),
      ...(batchId ? { batchId } : {}),
    }),
  });
  if (!res.ok) {
    console.error(`전송 실패 (${i + 1}/${parts.length}) HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const part = (await res.json()) as {
    batchId?: string; total?: number; new?: number; duplicates?: number; review?: number;
    period?: { from: string; to: string } | null;
  };
  batchId ??= part.batchId;
  total += part.total ?? 0;
  fresh += part.new ?? 0;
  dup += part.duplicates ?? 0;
  review += part.review ?? 0;
  if (part.period) {
    period = period
      ? { from: period.from < part.period.from ? period.from : part.period.from,
          to: period.to > part.period.to ? period.to : part.period.to }
      : part.period;
  }
  console.error(`  ${i + 1}/${parts.length} 보냄 (${rows.length}건)`);
}

// 다음 번에 어디서부터 보낼지 정하는 기준. **성공했을 때만** 적는다
if (!dry && period?.to) {
  try {
    writeFileSync(THROUGH, `${period.to}\n`);
  } catch (e) {
    console.error(`범위 기록 실패(다음에 전체를 올리게 됩니다): ${e}`);
  }
}

const range = period ? ` · ${period.from}~${period.to}` : "";
console.log(
  `${dry ? "[미리보기] " : ""}완료 — 전체 ${total}건${range}\n` +
    `  새로 ${fresh}건 · 중복 ${dup}건 · 확인 필요 ${review}건`,
);
