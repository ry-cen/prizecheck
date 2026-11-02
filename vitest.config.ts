import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "auth/tests/**/*.test.ts",
      "web/src/shell/**/*.test.ts",
      "web/src/catalog/**/*.test.ts",
      "web/src/decks/**/*.test.ts",
      "web/src/scanner/**/*.test.ts",
      "web/src/trades/**/*.test.ts",
      "web/src/ui/**/*.test.ts",
      "web/src/workspace/**/*.test.ts",
    ],
    testTimeout: 15_000,
    // `npm run verify -- --fast` runs vitest with --tags-filter=!slow. A slow file (`// @module-tag slow`) or test
    // (`tags: ["slow"]`) names its category in a comment: process, wall-clock, capacity or sleep.
    tags: [
      {
        name: "slow",
        description:
          "launches real processes, waits out real time, sleeps or builds capacity-sized data; left out by --fast",
      },
    ],
  },
});
