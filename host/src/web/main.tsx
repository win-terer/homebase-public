import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppShell } from "@homebase/ui";
import { primeRev } from "@homebase/core/web-cache";
import "@homebase/ui/styles.css";
import { Home } from "./Home.tsx";
import { webModules } from "./modules.ts";

// 데이터 버전을 미리 물어본다. 화면이 그려지는 동안 함께 돌아서, 첫 조회가 기다리지 않는다
primeRev();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AppShell nav={webModules}>
        <Routes>
          <Route index element={<Home />} />
          {webModules.map(({ id, path, Root }) => (
            <Route key={id} path={`${path}/*`} element={<Root />} />
          ))}
        </Routes>
      </AppShell>
    </BrowserRouter>
  </StrictMode>,
);
