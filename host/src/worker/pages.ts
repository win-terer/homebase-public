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
/* 권하지 않는 쪽(OTP 건너뛰기)은 단추처럼 보이지 않게 — 눈에 먼저 들어오면 안 된다 */
.skip { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.skip button.link { width: auto; height: auto; margin: 0; padding: 0; background: none; color: var(--muted); font-weight: 400; font-size: 14px; text-decoration: underline; }
.skip button.link:hover { color: var(--fg); }
.skip .note { margin: 6px 0 0; font-size: 13px; }
.hint { margin: 10px 0 0; font-size: 13px; line-height: 1.5; }
.hint b { color: var(--fg); font-weight: 600; }
code.inline { display: inline; padding: 1px 5px; border-radius: 5px; letter-spacing: 0; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><script>${THEME_BOOT}</script><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><title>${escape(title)} · homebase</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

const errorLine = (error?: string) => (error ? `<p class="error" role="alert">${escape(error)}</p>` : "");

/**
 * 막힌 사람에게 **나가는 길**을 보여 준다.
 *
 * 비밀번호를 잘못 넣고 설치하면 영영 못 들어간다고 생각하기 쉽다 — 실제로는 대시보드에서
 * 바꾸면 그만인데, 그 안내가 README 에만 있어서 **정작 막힌 화면에서는 안 보였다**
 * (사용자 지적 2026-11-20). 틀렸을 때만 띄운다 — 평소에 떠 있으면 잔소리다.
 */
const forgotLine = (error?: string) =>
  error
    ? `<p class="hint">비밀번호를 잊으셨나요? Cloudflare 대시보드 → <b>컴퓨트 → Workers 및 Pages</b> → 내 것 →
<b>설정 → 변수 및 시크릿</b> 에서 <code class="inline">LOGIN_PASSWORD</code> 를 바꾸면 바로 쓸 수 있어요. 다시 올릴 필요 없어요.</p>`
    : "";

/** `otp` 가 false 면 OTP 를 안 쓰기로 한 상태 — 코드 칸을 아예 그리지 않는다 */
export function loginPage(opts: { next: string; error?: string; otp?: boolean }): string {
  const otp = opts.otp !== false;
  return page(
    "로그인",
    `<h1>homebase</h1><p>${otp ? "비밀번호와 OTP 앱의 6자리 코드를 넣어주세요." : "비밀번호를 넣어주세요."}</p>
<form method="post" action="/login">
<input type="hidden" name="next" value="${escape(opts.next)}">
<label for="password">비밀번호</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
${otp ? `<label for="code">OTP 코드</label>
<input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>` : ""}
<button>로그인</button>${errorLine(opts.error)}${forgotLine(opts.error)}
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
<button>들어가기</button>${errorLine(opts.error)}${opts.error ? `<p class="hint">비밀번호는 이 달력을 만든 사람에게 물어보세요.</p>` : ""}
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
<button>다음</button>${errorLine(error)}${forgotLine(error)}
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
</form>
<!-- OTP 는 **권하는 쪽**이라 QR 을 먼저 보여 주고, 건너뛰기는 그 아래 작게 둔다.
     설치하자마자 QR 부터 찍으라고 하면 거기서 그만두는 사람이 생긴다 (2026-11-20) -->
<form method="post" action="/setup/skip" class="skip">
<button type="submit" class="link">OTP 없이 쓸래요</button>
<p class="note">비밀번호 하나로 열리게 됩니다. 나중에 홈 화면에서 켤 수 있어요.</p>
</form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`);
}
