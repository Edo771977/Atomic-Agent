import { readFileSync } from "node:fs";
import { maskSecrets } from "../error-reporting/secret-detector.js";
import { runtimeKnownSecrets } from "../runtime/runtime-known-secrets.js";
import { getConfig } from "../config/index.js";
import { serveApiKeyPath } from "./serve-api-key.js";
import { describe, expect, it, vi } from "vitest";

import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import type { CreateAgentRuntimeOptions } from "../runtime/bootstrap.js";
import { StructuredLogger } from "../tracing/structured-logger.js";

import { serveCommand } from "./serve-command.js";

/** What `serveCommand` handed `createAgentRuntime`, the last time it ran. */
const boot = vi.hoisted(() => ({
  known: null as ReturnType<typeof runtimeKnownSecrets> | null,
  options: null as CreateAgentRuntimeOptions | null,
}));

// `serveCommand` runs for real up to the runtime it would boot. The
// stand-in keeps the options serve built and refuses, so serve takes its
// failure path and returns without listening on anything.
vi.mock("../runtime/bootstrap.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../runtime/bootstrap.js")>();
  return {
    ...actual,
    createAgentRuntime: async (options: CreateAgentRuntimeOptions) => {
      boot.options = options;
      boot.known = runtimeKnownSecrets({});
      throw new Error("runtime stand-in: not booting");
    },
  };
});

/** Run `serve` up to its runtime and return what it passed there. */
async function serveBootOptions(): Promise<CreateAgentRuntimeOptions> {
  boot.options = null;
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  try {
    // 1: the stand-in refused, and serve said so on (silenced) stderr.
    expect(await serveCommand([])).toBe(1);
  } finally {
    stderr.mockRestore();
  }
  if (boot.options === null) throw new Error("serve never booted a runtime");
  return boot.options;
}

// `serve` shares the boot contract with `run` and `tui` by calling the
// same resolver; this test pins the contract at serve's import site.
describe("serve boot approval level (resolveBootApprovalLevel)", () => {
  it("matches the run/tui boot contract: persisted level is the baseline", () => {
    // Persisted agent.approvalLevel=1, no flag: everything still asks.
    expect(resolveBootApprovalLevel(false, 1)).toBe(1);
    // The Privacy-tab ladder persisted 3: serve must honor it, the
    // panel promises "applies to future runs too".
    expect(resolveBootApprovalLevel(false, 3)).toBe(3);
  });

  it("--no-approval can only force level 5, never a stricter level", () => {
    expect(resolveBootApprovalLevel(true, 1)).toBe(5);
    expect(resolveBootApprovalLevel(true, 5)).toBe(5);
  });
});

// The desktop app runs `atag serve` and relays its stderr into agent.log.
// The sinks serve passes are the runtime's only way into that file: serve
// used to pass the sink factory itself, and nothing was ever written. So
// this reads the sinks `serveCommand` really passes, not a helper's.
describe("what serve hands the runtime", () => {
  it("log sinks that write the structured log to stderr, at the configured level", async () => {
    const { handlers } = await serveBootOptions();
    const sinks = handlers?.logSinks ?? [];
    expect(sinks).toHaveLength(1);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      // The runtime builds its logger this way (`createAgentRuntime`):
      // the configured level is the gate, the sinks only write.
      const logger = new StructuredLogger({ level: "info", sinks });
      logger.debug("below the configured level");
      logger.warn("provider unreachable; parking the turn", {
        error: "fetch failed",
        causeCode: "ECONNREFUSED",
      });
      const written = stderr.mock.calls.map((c) => String(c[0])).join("");
      // The shape the desktop reads a line's level from.
      expect(written).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] WARN provider unreachable; parking the turn \{/,
      );
      expect(written).toContain('"causeCode":"ECONNREFUSED"');
      expect(written).not.toContain("below the configured level");
    } finally {
      stderr.mockRestore();
    }
  });

  // Under the desktop, a host that died leaves stderr a dead pipe, and
  // the next log line exited the process before its teardown ran (the
  // port, the session store's turn ends, the serve record). Muted, the
  // orphan watch ends it the way SIGTERM would.
  it("a broken stderr is muted, not a reason to exit", async () => {
    const options = await serveBootOptions();
    expect(options.brokenPipe).toBe("mute");
  });
});

// ATO-760: an open network port with no key hands the agent, its shell
// and its config file to anyone on the network. Serve stops at the parse,
// before a runtime (and so a listening socket) exists.
describe("serve on a network host without a key", () => {
  it("exits 1 with how to set a key, and never boots a runtime", async () => {
    vi.stubEnv("ATOMIC_AGENT_API_KEY", "");
    boot.options = null;
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(await serveCommand(["--host", "0.0.0.0"])).toBe(1);
      const written = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain("serve: --host 0.0.0.0");
      expect(written).toContain("ATOMIC_AGENT_API_KEY");
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(boot.options).toBeNull();
  });
});

describe("serveConstraintNote (issue #33)", () => {
  it("names the constrained folders a network server refuses, and is silent on loopback or when all allow serve", async () => {
    const { serveConstraintNote } = await import("./serve-command.js");
    const constraints = { "/clienti/acme": { allowedEgress: ["channels"] }, "/clienti/open": { allowedEgress: ["serve"] } };
    expect(serveConstraintNote("0.0.0.0", constraints)).toContain("/clienti/acme");
    expect(serveConstraintNote("0.0.0.0", constraints)).not.toContain("/clienti/open");
    expect(serveConstraintNote("127.0.0.1", constraints)).toBeNull();
    expect(serveConstraintNote("0.0.0.0", { "/clienti/open": { allowedEgress: ["serve"] } })).toBeNull();
  });
});

// ATO-625: a tunnel that cannot be made safe never opens, and nothing
// boots: no cloudflared on PATH is an error with how to install it.
describe("serve --tunnel without cloudflared", () => {
  it("exits 1 with an install hint, and never boots a runtime", async () => {
    vi.stubEnv("PATH", "");
    vi.stubEnv("Path", "");
    boot.options = null;
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(await serveCommand(["--tunnel"])).toBe(1);
      const written = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain("cloudflared");
      expect(written).toContain("never downloads");
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(boot.options).toBeNull();
  });
});

// Issue #74: the desktop passes its per-launch key in the environment, not
// on the command line `ps` shows. serve reads it and then removes it, so a
// tool, a shell or any child serve starts never inherits it.
describe("the API key from the environment", () => {
  it("is taken out of process.env once serve has read it", async () => {
    vi.stubEnv("ATOMIC_AGENT_API_KEY", "k".repeat(32));
    try {
      await serveBootOptions();
      expect(process.env.ATOMIC_AGENT_API_KEY).toBeUndefined();
      expect("ATOMIC_AGENT_API_KEY" in process.env).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

it("rejects the old key printing flag even from an unmarked process", async () => {
  vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", undefined);
  vi.stubEnv("ATOMIC_AGENT_API_KEY", "synthetic-serve-no-print-key");
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    expect(await serveCommand(["--print-api-key"])).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join("")).not.toContain("synthetic-serve-no-print-key");
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("warns once when the serve key comes from the environment", async () => {
  vi.stubEnv("ATOMIC_AGENT_API_KEY", "synthetic-serve-warning-key");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await serveCommand([]);
    const output = stderr.mock.calls.flat().join("");
    expect(output.match(/use --api-key-file/g)).toHaveLength(1);
    expect(output).not.toContain("synthetic-serve-warning-key");
  } finally {
    stderr.mockRestore();
    vi.unstubAllEnvs();
  }
});

it.each(["plainlowercasesynthetickey", undefined])("registers the active serve key for masking (%s)", async (given) => {
  vi.stubEnv("ATOMIC_AGENT_API_KEY", given);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await serveCommand([]);
    const key = given ?? readFileSync(serveApiKeyPath(getConfig().paths.stateDir), "utf8").trim();
    expect(maskSecrets("tool output: " + key, boot.known ?? [])).toBe("tool output: [redacted:serve-api-key]");
    expect(runtimeKnownSecrets({}).some(secret => secret.value === key)).toBe(false);
  } finally {
    stderr.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("round2-3 warns once when a key was passed on the command line", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await serveCommand(["--api-key", "synthetic-argv-credential"]);
    const output = stderr.mock.calls.flat().join("");
    expect(output.match(/use --api-key-file/g)).toHaveLength(1);
    expect(output).not.toContain("synthetic-argv-credential");
  } finally {
    stderr.mockRestore();
  }
});
