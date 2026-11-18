import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapSidecar } from "./main.js";
import { resetConfigCache } from "../config/index.js";
import type { SidecarMessage } from "./sidecar-events.js";

/** Issue #74: a sidecar request's sessionId must be a plain token, like HTTP's. */
describe("sidecar sessionId validation", () => {
  let stateDir: string;
  let stdout: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-sid-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", stateDir);
    resetConfigCache();
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it("refuses a traversing sessionId by name", async () => {
    const streams: Array<[NodeJS.EventEmitter, string]> = [
      [process.stdin, "data"], [process.stdin, "end"], [process.stdout, "error"], [process.stdout, "close"],
    ];
    const kept = streams.map(([emitter, event]) => [emitter, event, emitter.listeners(event).slice()] as const);
    const { shutdown } = await bootstrapSidecar();
    const ask = async (id: string, type: string, payload: unknown): Promise<SidecarMessage | undefined> => {
      process.stdin.emit("data", `${JSON.stringify({ kind: "request", id, type, payload })}\n`);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const found = stdout.join("").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as SidecarMessage)
          .find((m) => m.kind === "response" && m.correlationId === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 10));
      }
      return undefined;
    };
    try {
      for (const type of ["get_provider_restriction", "get_compaction", "get_project", "get_session", "project_decision"]) {
        const bad = await ask(`bad-${type}`, type, { sessionId: "../../x" });
        expect(bad?.kind === "response" && bad.ok, type).toBe(false);
        expect(JSON.stringify(bad), type).toContain("invalid sessionId");
      }
      const good = await ask("good", "get_provider_restriction", { sessionId: "s-1" });
      expect(JSON.stringify(good)).toContain("no active runtime");
    } finally {
      for (const [emitter, event, listeners] of kept) {
        for (const l of emitter.listeners(event)) if (!listeners.includes(l)) emitter.removeListener(event, l as () => void);
      }
      await shutdown();
    }
  });
});
