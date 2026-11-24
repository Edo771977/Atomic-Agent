import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      // The pure part of the Linux packaging (deb/rpm/AUR, the apt/dnf
      // repository): names, versions, layout and upload order, no I/O.
      "scripts/**/*.test.ts",
      // Memory-fabric benchmark campaign config + harness unit tests.
      // Kept here (vs the eval-memory vitest config which only runs
      // *.eval.ts under `npm run eval:memory`) because these are
      // hermetic — no llama-server, no judge, no embedding daemon.
      // Pure parts of the eval harness (attack checks, report, model
      // label): no agent, no llama-server.
      "eval/harness/**/*.test.ts",
      "eval-memory/config/**/*.test.ts",
      "eval-memory/harness/**/*.test.ts",
      "eval-memory/experiments/**/*.test.ts",
      "eval-memory/competitors/**/*.test.ts",
      // promptfoo provider helpers and the shape of the regression set;
      // hermetic, the promptfoo runs themselves are `npm run eval:promptfoo`.
      "eval/promptfoo/**/*.test.ts",
    ],
    environment: "node",
    // Concurrent Git for Windows worktree fixtures contend on the same temp volume.
    // Keep their real command deadlines meaningful even on many-core developer machines.
    ...(process.platform === "win32" ? { maxWorkers: 2 } : {}),
    testTimeout: 15_000,
    reporters: process.env.ATAG_VERIFY_TEST_REPORT ? ["default", "json"] : ["default"],
    ...(process.env.ATAG_VERIFY_TEST_REPORT ? { outputFile: { json: process.env.ATAG_VERIFY_TEST_REPORT } } : {}),
    setupFiles: ["src/test-setup.ts"],
  },
});
