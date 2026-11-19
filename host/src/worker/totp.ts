/** TOTP (RFC 6238, SHA-1, 6자리, 30초). 구글 OTP·Authy 등 일반 OTP 앱과 호환 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export async function hotp(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret) as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new DataView(new ArrayBuffer(8));
  msg.setUint32(0, Math.floor(counter / 2 ** 32));
  msg.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg.buffer));
  const offset = mac[mac.length - 1]! & 15;
  const code =
    (((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!) % 1_000_000;
  return String(code).padStart(6, "0");
}

export const counterAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/**
 * 코드가 맞으면 그 시간 칸(counter)을, 틀리면 null. 폰 시계 오차를 생각해 앞뒤 한 칸(±30초)까지 본다.
 * afterCounter 이하의 칸은 이미 쓴 코드라 받지 않는다 (재사용 방지).
 */
export async function verifyTotp(secret: string, code: string, nowMs: number, afterCounter = 0): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const now = counterAt(nowMs);
  for (const c of [now, now - 1, now + 1]) {
    if (c <= afterCounter) continue;
    if ((await hotp(secret, c)) === code) return c;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
