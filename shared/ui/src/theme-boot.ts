/**
 * 첫 화면이 깜빡이지 않게 <head> 에서 React 보다 먼저 실행하는 스크립트.
 * theme.tsx 의 규칙과 같다: hb.theme 이 light/dark 면 그대로, 없으면 기기 설정.
 * 로그인 화면(워커가 만드는 HTML)과 앱 화면(index.html)이 같이 쓴다.
 */
export const THEME_KEY = "hb.theme";

export const THEME_BOOT = `try{var m=localStorage.getItem("${THEME_KEY}");document.documentElement.dataset.theme=m==="light"||m==="dark"?m:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch(e){}`;
