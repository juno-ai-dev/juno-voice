import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { TEST_DEPLOYMENT_ENV } from "./src/test/deployment";

const releaseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

if (!/^[0-9a-f]{40}$/.test(releaseCommit))
  throw new Error("Playwright requires an exact 40-character release commit.");
process.env.PLAYWRIGHT_RELEASE_COMMIT = releaseCommit;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run preview -- --host 127.0.0.1",
    env: {
      ...TEST_DEPLOYMENT_ENV,
      VITE_BASE_PATH: "/juno-voice/",
      VITE_RELEASE_COMMIT: releaseCommit,
    },
    url: "http://127.0.0.1:4173/juno-voice/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
