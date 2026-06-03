import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config. The suite runs against a local dev server that
 * Playwright starts automatically (`npm run dev`). No environment variables or
 * external services are required for the default suite: the streaming test mocks
 * `/api/chat`, so it never touches a real model backend.
 */
const PORT = Number(process.env.PORT) || 3041;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
