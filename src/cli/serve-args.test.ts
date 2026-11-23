import { linkSync, chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HELP,
  isLoopbackListenHost,
  lanUrls,
  parseArgs,
  type ServeArgs,
} from "./serve-args.js";

function parsedOk(args: string[]): ServeArgs {
  const parsed = parseArgs(args);
  if ("help" in parsed || "error" in parsed) {
    throw new Error(`expected a parse, got ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function parseError(args: string[]): string {
  const parsed = parseArgs(args);
  if (!("error" in parsed)) {
    throw new Error(`expected an error, got ${JSON.stringify(parsed)}`);
  }
  return parsed.error;
}

beforeEach(() => {
  // An operator's own key in the environment must not hide a missing one.
  vi.stubEnv("ATOMIC_AGENT_API_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("serve refuses a network host without an API key (ATO-760)", () => {
  it.each(["0.0.0.0", "::", "[::]", "192.168.1.20", "10.0.0.5", "my-box.lan"])(
    "--host %s without a key is an error that says how to set one",
    (host) => {
      const error = parseError(["--host", host]);
      expect(error).toContain(`--host ${host}`);
      expect(error).toContain("--api-key");
      expect(error).toContain("ATOMIC_AGENT_API_KEY");
    },
  );

  it("starts on a network host with --api-key", () => {
    const parsed = parsedOk(["--host", "0.0.0.0", "--api-key", "s3cret-0123456789ab"]);
    expect(parsed.host).toBe("0.0.0.0");
    expect(parsed.apiKey).toBe("s3cret-0123456789ab");
  });

  it("starts on a network host with ATOMIC_AGENT_API_KEY", () => {
    vi.stubEnv("ATOMIC_AGENT_API_KEY", "from-env-0123456789");
    const parsed = parsedOk(["--host", "0.0.0.0"]);
    expect(parsed.apiKey).toBe("from-env-0123456789");
  });

  it("refuses a short key on a network host, and on loopback (ATO-1126)", () => {
    expect(parseError(["--host", "0.0.0.0", "--api-key", "short"])).toContain("at least 16");
    expect(parseError(["--api-key", "short"])).toContain("at least 16");
  });

  it("rejects an empty --api-key instead of treating it as a key", () => {
    expect(parseError(["--api-key", ""])).toContain("--api-key");
  });

  it("does not ask for a key to sweep strays with --reap", () => {
    expect(parsedOk(["--host", "0.0.0.0", "--reap"]).reapOnly).toBe(true);
  });
});

describe("loopback without a given key parses, for serve's own generated key", () => {
  // `apiKey: null` means "none given": serveCommand then runs with the
  // key in <stateDir>/serve-api.key (serve-api-key.test.ts), never keyless.
  it.each(["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]"])(
    "--host %s without a key parses",
    (host) => {
      expect(parsedOk(["--host", host]).apiKey).toBeNull();
    },
  );

  it("the default host is loopback and parses without a key", () => {
    const parsed = parsedOk([]);
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.apiKey).toBeNull();
  });

  it("the help says a key is always required and where serve keeps its own", () => {
    expect(HELP).toContain("serve-api.key");
    expect(HELP).toContain("always required");
    expect(HELP).not.toContain("--print-api-key");
    expect(HELP).not.toContain("ATOMIC_AGENT_ALLOWED_ORIGINS");
  });
});

describe("the desktop app's launch line", () => {
  it("parses unchanged: loopback host, a per-launch key", () => {
    // desktop/main/agent-client.ts spawns exactly this shape.
    const parsed = parsedOk([
      "--host", "127.0.0.1", "--port", "51234", "--api-key", "a".repeat(48),
    ]);
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(51234);
    expect(parsed.apiKey).toBe("a".repeat(48));
  });
});

describe("an API key of only whitespace", () => {
  it("is refused from the flag and from the environment, on any host", () => {
    expect(parseError(["--host", "127.0.0.1", "--api-key", "   "])).toMatch(/only whitespace/);
    vi.stubEnv("ATOMIC_AGENT_API_KEY", " ".repeat(24));
    expect(parseError(["--host", "0.0.0.0"])).toMatch(/only whitespace/);
  });
  it("does not block --reap, which serves nothing", () => {
    vi.stubEnv("ATOMIC_AGENT_API_KEY", "  ");
    expect(parsedOk(["--reap"]).reapOnly).toBe(true);
  });
});

describe("isLoopbackListenHost", () => {
  it("is true only for hosts that accept local connections only", () => {
    expect(isLoopbackListenHost("127.0.0.1")).toBe(true);
    expect(isLoopbackListenHost("localhost.")).toBe(true);
    expect(isLoopbackListenHost("0.0.0.0")).toBe(false);
    expect(isLoopbackListenHost("::")).toBe(false);
    expect(isLoopbackListenHost("128.0.0.1")).toBe(false);
    expect(isLoopbackListenHost("127.evil.example")).toBe(false);
  });

  it("reads IP literals the way the socket will, never by pattern alone", () => {
    // Every spelling of the IPv6 loopback, and IPv4-mapped 127/8.
    for (const h of ["::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "[::ffff:127.1.2.3]", "127.255.0.9"]) {
      expect(isLoopbackListenHost(h), h).toBe(true);
    }
    // Not IP literals, or not loopback: a key is required for these.
    for (const h of ["127.0.0.256", "127.1", "::ffff:10.0.0.1", "::2", "fe80::1%eth0"]) {
      expect(isLoopbackListenHost(h), h).toBe(false);
    }
  });
});

describe("lanUrls (ATO-1126)", () => {
  const nics = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }],
  } as unknown as Parameters<typeof lanUrls>[2];
  it("lists this machine's LAN addresses when serve listens everywhere", () => {
    expect(lanUrls("0.0.0.0", 8787, nics)).toEqual(["http://192.168.1.20:8787"]);
    expect(lanUrls("::", 8787, nics)).toEqual(["http://192.168.1.20:8787"]);
  });
  it("lists nothing for loopback or one named host", () => {
    expect(lanUrls("127.0.0.1", 8787, nics)).toEqual([]);
    expect(lanUrls("192.168.1.20", 8787, nics)).toEqual([]);
  });
});

describe("serve --help endpoints", () => {
  it("lists the chat export and resume routes", () => {
    expect(HELP).toContain("GET  /api/sessions/{id}/export");
    expect(HELP).toContain("POST /api/sessions/{id}/resume");
  });
});

describe("serve --tunnel flags (ATO-625)", () => {
  it("is off unless asked for", () => {
    expect(parsedOk([]).tunnel).toBeNull();
  });

  it("--tunnel asks for a quick tunnel", () => {
    expect(parsedOk(["--tunnel"]).tunnel).toEqual({ mode: "quick" });
  });

  it("--tunnel-name with --tunnel-hostname asks for a named tunnel", () => {
    expect(
      parsedOk(["--tunnel-name", "hooks", "--tunnel-hostname", "https://Hooks.Example.com/"]).tunnel,
    ).toEqual({ mode: "named", name: "hooks", hostname: "hooks.example.com" });
  });

  it("a named tunnel needs both flags, and a real hostname", () => {
    expect(parseError(["--tunnel-name", "hooks"])).toContain("--tunnel-hostname");
    expect(parseError(["--tunnel-hostname", "hooks.example.com"])).toContain("--tunnel-name");
    expect(parseError(["--tunnel-name", "hooks", "--tunnel-hostname", "hooks.example.com/x"])).toContain("hostname");
    expect(parseError(["--tunnel-name"])).toContain("requires a value");
    expect(parseError(["--tunnel-name", "--tunnel"])).toContain("requires a value");
  });
});

it.skipIf(process.platform === "win32")("rejects loose permissions and symlinks for an explicit key file", () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-explicit-auth-"));
  try {
    const path = join(dir, "key");
    const link = join(dir, "link");
    writeFileSync(path, "synthetic-file-key\n", { mode: 0o600 });
    symlinkSync(path, link);
    expect(parseError(["--api-key-file", link])).toMatch(/owner|symlink/i);
    chmodSync(path, 0o644);
    expect(parseError(["--api-key-file", path])).toMatch(/0600|owner/i);
    chmodSync(path, 0o600);
    expect(parsedOk(["--api-key-file", path]).apiKey).toBe("synthetic-file-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("round2-2 rejects a short environment key on loopback", () => {
  vi.stubEnv("ATOMIC_AGENT_API_KEY", "short");
  expect(parseError([])).toContain("at least 16");
});

it.skipIf(process.platform === "win32")("round2-5 refuses a hard-linked explicit key", () => {
  const dir = mkdtempSync(join(tmpdir(), "explicit-linked-key-"));
  try {
    const path = join(dir, "key");
    writeFileSync(path, "synthetic-explicit-linked-key", { mode: 0o600 });
    linkSync(path, join(dir, "other"));
    expect(parseError(["--api-key-file", path])).toMatch(/hard link/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
