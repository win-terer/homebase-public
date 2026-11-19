import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{host,apps,shared}/**/src/**/*.test.ts"],
  },
});
