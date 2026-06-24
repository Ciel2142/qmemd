import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    testTimeout: 60000,
    // qmemd-k9q: type-level SDK contract pins (test/*.test-d.ts) — tsconfig only
    // covers src/, so the pins need their own tsc program; with the default
    // ./tsconfig.json the test-d file is outside `include` and vitest reports
    // "no errors" without ever checking it (verified by a negative probe).
    typecheck: { enabled: true, tsconfig: "./tsconfig.typecheck.json" },
  },
});
