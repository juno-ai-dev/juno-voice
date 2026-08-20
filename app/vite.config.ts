import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { configDefaults } from "vitest/config";
import { normalizeBase } from "./src/deployment";
import { loadConfig, type ConfigEnvironment } from "./src/config";

export default defineConfig(({ command, mode }) => {
  const environment = { ...process.env, ...loadEnv(mode, process.cwd(), "") };
  if (command === "build") loadConfig(environment as ConfigEnvironment);
  return {
    base: normalizeBase(environment.VITE_BASE_PATH),
    plugins: [react()],
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
