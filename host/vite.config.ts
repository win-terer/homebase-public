import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    // 엑셀 라이브러리(가져오기 화면에서만 불러옴)가 커서 경고 기준을 올린다
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      /**
       * 화면이 둘이다. **동거인 화면은 번들을 따로 묶는다** — 한 덩어리로 두면 일정 한 카테고리만
       * 보는 사람 브라우저에 가계부 코드가 통째로 내려간다. 워커가 `/guest` 요청을 guest.html 로
       * 돌린다 (host/src/worker/app.ts).
       */
      input: {
        index: fileURLToPath(new URL("src/web/index.html", import.meta.url)),
        // 폴더 + index.html 로 둔다. **`.html` 로 끝나는 경로를 Assets 에 요청하면 안 된다** —
        // Workers Assets 가 확장자를 뗀 주소로 301 을 돌려주는데(html_handling 기본값), 워커가
        // 그걸 그대로 넘기면 브라우저가 `/guest` 를 다시 요청해 끝없이 돈다 (2026-11-19).
        guest: fileURLToPath(new URL("src/web/guest/index.html", import.meta.url)),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/login": "http://127.0.0.1:8787",
      "/setup": "http://127.0.0.1:8787",
      "/logout": "http://127.0.0.1:8787",
      "/guest/login": "http://127.0.0.1:8787",
      "/guest/logout": "http://127.0.0.1:8787",
    },
  },
});
