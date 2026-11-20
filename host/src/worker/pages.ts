/** 로그인·OTP 등록 화면 (서버에서 바로 그리는 작은 HTML. 로그인 전이라 앱 번들은 주지 않는다) */
import { THEME_BOOT } from "@homebase/ui/theme-boot";

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const STYLE = `
:root { --page:#f4f5f7; --surface:#fff; --fg:#1f2328; --muted:#646b75; --border:#e3e5e8; --accent:#2f6fde; --danger:#c2413a; color-scheme: light; }
:root[data-theme="dark"] { --page:#131417; --surface:#1c1d21; --fg:#e8e9ec; --muted:#9aa0a8; --border:#2c2e33; --accent:#6b9cf0; --danger:#f08a82; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--page); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif; }
main { width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 28px 26px; }
h1 { margin: 0 0 4px; font-size: 19px; font-weight: 600; }
p { margin: 0 0 16px; color: var(--muted); font-size: 14px; }
label { display: block; margin: 14px 0 6px; font-size: 13px; color: var(--muted); }
input { width: 100%; height: 42px; padding: 0 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); color: inherit; font: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
input[inputmode=numeric] { letter-spacing: .2em; font-variant-numeric: tabular-nums; }
button { width: 100%; height: 42px; margin-top: 20px; border: 0; border-radius: 9px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.error { margin: 12px 0 0; color: var(--danger); font-size: 14px; }
.qr { display: block; width: 200px; height: 200px; margin: 8px auto 12px; background: #fff; padding: 8px; border-radius: 8px; }
code { display: block; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; word-break: break-all; text-align: center; letter-spacing: .08em; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><script>${THEME_BOOT}</script><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><title>${escape(title)} · homebase</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

const errorLine = (error?: string) => (error ? `<p class="error" role="alert">${escape(error)}</p>` : "");

export function loginPage(opts: { next: string; error?: string }): string {
  return page(
    "로그인",
    `<h1>homebase</h1><p>비밀번호와 OTP 앱의 6자리 코드를 넣어주세요.</p>
<form method="post" action="/login">
<input type="hidden" name="next" value="${escape(opts.next)}">
<label for="password">비밀번호</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<label for="code">OTP 코드</label>
<input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
<button>로그인</button>${errorLine(opts.error)}
</form>`,
  );
}

export function guestLoginPage(opts: { error?: string }): string {
  return page(
    "함께 쓰기",
    `<h1>함께 쓰기</h1><p>비밀번호를 넣으면 함께 보기로 한 일정이 열려요.</p>
<form method="post" action="/guest/login">
<label for="password">비밀번호</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button>들어가기</button>${errorLine(opts.error)}
</form>`,
  );
}

export function setupPasswordPage(error?: string): string {
  return page(
    "OTP 등록",
    `<h1>OTP 등록</h1><p>처음 한 번만 해요. 대시보드에 넣은 비밀번호(LOGIN_PASSWORD)를 넣으면 OTP 앱에 등록할 QR 이 나와요.</p>
<form method="post" action="/setup">
<label for="password">비밀번호</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button>다음</button>${errorLine(error)}
</form>`,
  );
}

export function setupQrPage(opts: { qrSvg: string; secret: string; error?: string }): string {
  const src = `data:image/svg+xml;base64,${btoa(opts.qrSvg)}`;
  return page(
    "OTP 등록",
    `<h1>OTP 앱에 등록</h1><p>구글 OTP·Authy 같은 앱에서 QR 을 찍고, 앱에 나온 6자리 코드를 넣어주세요.</p>
<img class="qr" src="${src}" alt="OTP 등록 QR 코드">
<p>QR 을 못 찍으면 이 키를 직접 입력하세요.</p><code>${escape(opts.secret.replace(/(.{4})/g, "$1 ").trim())}</code>
<form method="post" action="/setup/confirm">
<label for="code">OTP 코드</label>
<input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus>
<button>등록 완료</button>${errorLine(opts.error)}
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`);
}
