import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["scripts/auth/*.vitest.ts"],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
