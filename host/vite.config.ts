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
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/login": "http://127.0.0.1:8787",
      "/setup": "http://127.0.0.1:8787",
      "/logout": "http://127.0.0.1:8787",
    },
  },
});
