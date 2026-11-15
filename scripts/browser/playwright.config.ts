import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "*.pw.ts",
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:4499",
    browserName: "chromium",
    launchOptions: process.env.TAPEDB_CHROMIUM
      ? { executablePath: process.env.TAPEDB_CHROMIUM }
      : {},
  },
  webServer: {
    command: "node scripts/browser/server.mjs",
    cwd: resolve(import.meta.dirname, "../.."),
    url: "http://127.0.0.1:4499",
    reuseExistingServer: false,
  },
});
