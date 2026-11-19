/**
 * 설정에 섞여 들어오는 **비밀값**(메일 비밀번호·zip 암호)을 D1 에 둘 수 있게 봉한다.
 *
 * 왜 필요한가 — 이 값들은 원래 맥 키체인에만 있었다. 설정을 웹 화면에서 하게 되면서 서버에
 * 둬야 하는데, D1 은 대시보드에서 그대로 보이고 백업에도 평문으로 들어간다. 메일 비밀번호가
 * 가계부 데이터와 **같은 위험도로 굴러다니면 안 된다** — 그 계정으로 할 수 있는 일이 훨씬 많다.
 *
 * 열쇠는 워커 Secret `SETTINGS_KEY` 하나다. **열쇠가 없으면 봉하지 못하고, 봉하지 못하면 저장하지
 * 않는다** — 평문으로 두느니 기능을 끄는 쪽이 낫다. 열쇠를 잃으면 봉한 값은 영영 못 읽으니
 * 다시 입력해야 한다(가계부 데이터는 멀쩡하다).
 *
 * AES-GCM 256. 열쇠는 Secret 의 SHA-256, 나머지 열두 바이트는 그때그때 새로 뽑는 IV 다.
 */
const PREFIX = "enc1:";

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

/** 이미 봉해진 값인지 (저장된 설정을 다시 저장할 때 두 번 봉하지 않으려고) */
export const isSealed = (value: unknown): value is string => typeof value === "string" && value.startsWith(PREFIX);

/** 평문 → `enc1:<base64(iv + 암호문)>`. 열쇠가 없으면 null (부르는 쪽이 저장을 포기해야 한다) */
export async function seal(plain: string, secret: string | undefined): Promise<string | null> {
  if (!secret) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(secret);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)));
  const both = new Uint8Array(iv.length + sealed.length);
  both.set(iv);
  both.set(sealed, iv.length);
  return PREFIX + toBase64(both);
}

/**
 * 봉한 값 → 평문. 열쇠가 다르거나 값이 깨졌으면 **null** 이다 (던지지 않는다 —
 * 열쇠를 바꾼 뒤에도 화면은 떠야 하고, "다시 입력하세요" 로 안내하면 된다).
 * 봉해지지 않은 값은 그대로 돌려준다 — 열쇠를 넣기 전에 저장된 값이 섞여 있을 수 있다.
 */
export async function open(sealed: string, secret: string | undefined): Promise<string | null> {
  if (!isSealed(sealed)) return sealed;
  if (!secret) return null;
  try {
    const both = fromBase64(sealed.slice(PREFIX.length));
    const key = await aesKey(secret);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: both.slice(0, 12) }, key, both.slice(12));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
