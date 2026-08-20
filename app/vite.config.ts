import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";
import { normalizeBase } from "./src/deployment";
import { loadConfig, type ConfigEnvironment } from "./src/config";
import { createPresignDev } from "./scripts/presign-dev.mjs";

export default defineConfig(({ command, mode, isPreview }) => {
  const environment = { ...process.env, ...loadEnv(mode, process.cwd(), "") };
  if (command === "build") loadConfig(environment as ConfigEnvironment);
  // Same-origin presign (and, without a Pinata JWT, a local pin store) for
  // `vite dev` only. It refuses to attach to builds, previews, and vitest, so
  // no production artifact can depend on a development endpoint.
  const presignDev = createPresignDev({ command, mode, isPreview, env: environment });
  Object.assign(process.env, presignDev.env);
  return {
    base: normalizeBase(environment.VITE_BASE_PATH),
    plugins: presignDev.plugin ? [react(), presignDev.plugin] : [react()],
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      css: false,
      // Generous ceiling for loaded CI machines; local runs finish far sooner.
      testTimeout: 15_000,
      exclude: [...configDefaults.exclude, "e2e/**", "scripts/**"],
    },
  };
});
