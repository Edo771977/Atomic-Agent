import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

// Integration fixtures may boot the production runtime. Only injected test keyrings are usable.
vi.mock("./native/load-keyring.js", () => ({ loadKeyring: () => null }));

/**
 * Vitest global setup: point every test at an isolated `STATE_DIR` so
 * that any accidental `getConfig()` call never writes to the user's real
 * `~/.atomic-agent/`. Tests that need a specific state dir override
 * `process.env.ATOMIC_AGENT_STATE_DIR` in their own `beforeEach`.
 */
if (!process.env.ATOMIC_AGENT_STATE_DIR) {
  process.env.ATOMIC_AGENT_STATE_DIR = mkdtempSync(
    join(tmpdir(), "atomic-agent-test-"),
  );
}

/**
 * Keep cloud skill discovery away from the real `~/.agents/skills`
 * (ATO-706): a missing folder means no shared skills in tests.
 */
if (!process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR) {
  process.env.ATOMIC_AGENT_SHARED_SKILLS_DIR = join(
    mkdtempSync(join(tmpdir(), "atomic-agent-shared-skills-")),
    "missing",
  );
}
