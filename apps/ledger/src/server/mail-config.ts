import type { SqlDb } from "@homebase/db";
import { isSealed, open, seal } from "@homebase/core/secrets";

/**
 * **메일에서 가계부 엑셀 자동으로 가져오기** 설정 (화면에서 고치고, 돌리는 도구가 받아 간다).
 *
 * 뱅크샐러드는 앱에서 "파일로 받기" 를 누르면 암호 걸린 zip 을 메일로 보낸다. 그걸 받아 풀고
 * 올려 주는 도구가 어딘가에서 돌아야 하는데, 그 도구가 알아야 할 것(메일 서버·계정·메일함·암호)을
 * 예전에는 **그 컴퓨터의 키체인과 코드 안 상수**에 박아 두었다. 쓰는 사람이 바뀌면 손댈 데가 많다.
 *
 * 그래서 설정은 여기(D1)에 두고 화면에서 고친다. 다만 **비밀값은 봉해서** 넣는다
 * (`@homebase/core/secrets`, 열쇠는 워커 Secret `SETTINGS_KEY`).
 *
 * ## 도구는 어떻게 받아 가나 — 일회용 연결 코드
 *
 * 가져오기 키(`IMPORT_TOKEN`)로 이 설정을 열어 주면, **그 키가 새는 순간 메일 비밀번호까지 샌다.**
 * 지금 그 키로 할 수 있는 일은 "엑셀 올리기" 뿐이고 그 범위를 넓히지 않기로 해 두었다.
 *
 * 대신 화면에서 **10분짜리 한 번 쓰는 코드**를 뽑는다. 도구를 설치할 때 그 코드로 한 번 받아 가고
 * (`claimMailLink`), 받아 간 값은 그 컴퓨터에 남는다. 코드는 쓰는 즉시 사라지고, DB 에는 코드의
 * 해시만 둔다. 설정을 바꿨으면 코드를 다시 뽑아 한 번 더 받아 가면 된다.
 */
const CONFIG_KEY = "mail.config";
const LINK_KEY = "mail.link";
const LINK_TTL_MS = 10 * 60_000;

/** 화면에서 고치는 값들. 비밀값은 따로 (아래 `MailSecrets`) */
export interface MailSettings {
  /** 꺼 두면 도구가 아무것도 하지 않는다 (설정은 남는다) */
  enabled: boolean;
  /** IMAP 주소. 예: `imap.naver.com` */
  host: string;
  port: number;
  user: string;
  /** 뱅샐 메일만 모아 둔 메일함. 비우면 받은편지함에서 보낸이로 찾는다 */
  mailbox: string;
  /** 이 주소에서 온 메일만 본다 */
  sender: string;
  /** 몇 분마다 볼지 (도구가 이 값으로 제 일정을 잡는다) */
  everyMinutes: number;
}

export interface MailSecrets {
  /** 메일 계정 비밀번호. 네이버·구글은 **앱 비밀번호**를 따로 받아야 한다 */
  password: string;
  /** 뱅샐 앱에서 내보낼 때 거는 zip 암호 */
  zipPassword: string;
  /** 예비 zip 암호 (내보낼 때 다른 걸 걸었을 수도 있어서, 없어도 됨) */
  zipPassword2: string;
}

/** 화면에 내려보내는 모양 — 비밀값은 **들어 있는지만** 알려준다 */
export interface MailConfigView extends MailSettings {
  hasPassword: boolean;
  hasZipPassword: boolean;
  hasZipPassword2: boolean;
  /** 열쇠(`SETTINGS_KEY`)가 없으면 비밀값을 저장할 수 없다 — 화면이 그 이유를 보여준다 */
  canStoreSecrets: boolean;
  /** 열쇠가 바뀌어 예전 비밀값을 못 읽는 상태 (다시 입력해야 한다) */
  secretsUnreadable: boolean;
}

export const DEFAULTS: MailSettings = {
  enabled: false,
  host: "",
  port: 993,
  user: "",
  mailbox: "",
  sender: "export-noreply@banksalad.com",
  everyMinutes: 10,
};

type Stored = MailSettings & { password?: string; zipPassword?: string; zipPassword2?: string };

async function readJson<T>(db: SqlDb, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value FROM ledger_settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

async function writeJson(db: SqlDb, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO ledger_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** 보낸 값에서 쓸 만한 것만 추려 낸다 (화면을 믿지 않는다) */
export function cleanSettings(input: unknown): MailSettings {
  const o = (input ?? {}) as Record<string, unknown>;
  const port = Number(o.port);
  const every = Number(o.everyMinutes);
  return {
    enabled: o.enabled === true,
    host: text(o.host, 120),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULTS.port,
    user: text(o.user, 200),
    mailbox: text(o.mailbox, 200),
    sender: text(o.sender, 200) || DEFAULTS.sender,
    // 너무 자주 보면 메일 서버가 막는다. 너무 뜸하면 알림 화면이 "멈췄다" 고 본다
    everyMinutes: Number.isFinite(every) ? Math.min(360, Math.max(5, Math.round(every))) : DEFAULTS.everyMinutes,
  };
}

export async function loadMailConfig(db: SqlDb, key: string | undefined): Promise<MailConfigView> {
  const stored = (await readJson<Stored>(db, CONFIG_KEY)) ?? { ...DEFAULTS };
  const settings = cleanSettings(stored);
  const sealedOnes = [stored.password, stored.zipPassword, stored.zipPassword2].filter(isSealed);
  // 열쇠를 바꾸면 예전 값은 못 읽는다. 조용히 비어 보이면 "왜 안 되지" 가 되므로 화면에 밝혀 준다
  const unreadable = sealedOnes.length > 0 && (!key || (await open(sealedOnes[0]!, key)) === null);
  return {
    ...settings,
    hasPassword: Boolean(stored.password),
    hasZipPassword: Boolean(stored.zipPassword),
    hasZipPassword2: Boolean(stored.zipPassword2),
    canStoreSecrets: Boolean(key),
    secretsUnreadable: unreadable,
  };
}

export class MailConfigError extends Error {}

/**
 * 설정 저장. 비밀값은 **보낸 것만** 덮어쓴다 — 화면은 값을 되돌려받지 못하므로, 안 보냈다는 건
 * "그대로 두라" 는 뜻이다. 빈 문자열을 보내면 지운다.
 */
export async function saveMailConfig(
  db: SqlDb,
  input: unknown,
  key: string | undefined,
): Promise<MailConfigView> {
  const o = (input ?? {}) as Record<string, unknown>;
  const before: Partial<Stored> = (await readJson<Stored>(db, CONFIG_KEY)) ?? {};
  const next: Stored = { ...cleanSettings(o) };

  for (const [field, raw] of [
    ["password", o.password],
    ["zipPassword", o.zipPassword],
    ["zipPassword2", o.zipPassword2],
  ] as const) {
    if (raw === undefined) {
      if (before[field]) next[field] = before[field];
      continue;
    }
    const value = text(raw, 300);
    if (!value) continue; // 빈 값 = 지우기
    const sealed = await seal(value, key);
    // 열쇠가 없으면 **평문으로 두지 않고 거절한다**
    if (!sealed) throw new MailConfigError("비밀값을 저장하려면 워커 Secret 에 SETTINGS_KEY 를 먼저 넣어야 해요.");
    next[field] = sealed;
  }

  await writeJson(db, CONFIG_KEY, next);
  return loadMailConfig(db, key);
}

/** 만들 때와 같은 모양인지 (base64url 24자) */
const CODE_SHAPE = /^[A-Za-z0-9_-]{24}$/;

const randomCode = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 연결 코드 만들기. 평문 코드는 **이때 한 번만** 나온다 (DB 에는 해시만) */
export async function makeMailLink(db: SqlDb): Promise<{ code: string; expiresAt: string }> {
  const code = randomCode();
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  await writeJson(db, LINK_KEY, { hash: await sha256(code), expiresAt });
  return { code, expiresAt };
}

export interface ClaimedConfig extends MailSettings, MailSecrets {
  /** 엑셀을 올릴 때 쓸 키 (워커 Secret). 설치하는 사람이 대시보드를 뒤지지 않아도 되게 같이 준다 */
  importToken: string;
}

/**
 * 코드를 내고 설정을 받아 간다. **성공하든 실패하든 코드는 한 번 쓰면 사라진다** (맞는 코드는 썼으니까,
 * 틀린 코드는 찍어 보는 것일 수 있으니까). 비밀값을 못 푸는 상태면 받아 가도 쓸모가 없으니 막는다.
 */
export async function claimMailLink(db: SqlDb, code: string, key: string | undefined, importToken: string | undefined): Promise<ClaimedConfig> {
  /**
   * **생긴 모양부터 본다.** 이 자리는 로그인 없이 열려 있어서 아무나 두드릴 수 있는데, 코드를
   * 쓰면 태우는 규칙 때문에 **남이 아무 값이나 보내 남의 코드를 태울 수 있다**(설치를 방해하고
   * D1 쓰기도 축낸다). 형식조차 아닌 값은 DB 를 건드리지 않고 돌려보낸다.
   */
  if (!CODE_SHAPE.test(String(code ?? ""))) throw new MailConfigError("연결 코드가 맞지 않아요. 설정 화면에서 새로 받아 주세요.");
  const link = await readJson<{ hash: string; expiresAt: string }>(db, LINK_KEY);
  if (!link) throw new MailConfigError("연결 코드가 없어요. 설정 화면에서 새로 받아 주세요.");
  const given = await sha256(String(code ?? ""));
  const ok = given === link.hash && Date.parse(link.expiresAt) > Date.now();
  await db.prepare("DELETE FROM ledger_settings WHERE key = ?").bind(LINK_KEY).run();
  if (!ok) throw new MailConfigError("연결 코드가 맞지 않거나 시간이 지났어요. 설정 화면에서 새로 받아 주세요.");

  const stored = (await readJson<Stored>(db, CONFIG_KEY)) ?? { ...DEFAULTS };
  const secret = async (value: string | undefined) => (value ? ((await open(value, key)) ?? "") : "");
  return {
    ...cleanSettings(stored),
    password: await secret(stored.password),
    zipPassword: await secret(stored.zipPassword),
    zipPassword2: await secret(stored.zipPassword2),
    importToken: importToken ?? "",
  };
}
