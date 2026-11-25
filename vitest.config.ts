import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // T1 and the kit each load the real embedded host; one file at a time keeps them from sharing OpenCode state.
    fileParallelism: false,
  },
})
