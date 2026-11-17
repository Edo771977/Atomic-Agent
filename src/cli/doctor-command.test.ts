import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../config/index.js";
import { doctorCommand } from "./doctor-command.js";
import { MemoryStore } from "../memory/memory-store.js";
import { ProfileStore } from "../memory/profile-store.js";
import { backfillConstraintScopes } from "../memory/memory-constraint-scope.js";
import { makeProviderPolicy } from "../config/project-constraint-match.js";
import { describeBetterSqliteBinding } from "./doctor-checks.js";

let dir: string;
let out: string;
const write = (t: string): void => { out += t; };
const cfgPath = (): string => join(dir, "config.json");
const save = (tree: unknown): void => { writeFileSync(cfgPath(), JSON.stringify(tree, null, 2)); chmodSync(cfgPath(), 0o600); };
const read = (): Record<string, any> => JSON.parse(readFileSync(cfgPath(), "utf8"));
const run = (args: string[], findOnPath = (_: string) => true) =>
  doctorCommand(args, { stateDir: dir, write, engine: null, context: { findOnPath } });

function withBrokenActiveProvider(): Record<string, any> {
  const tree = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, any>;
  tree.llm = {
    ...tree.llm,
    activeTextProvider: "gone",
    providers: [{ id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" }],
  };
  return tree;
}

function withMcp(command: string): Record<string, any> {
  const tree = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, any>;
  tree.mcp = { servers: [{ name: "files", enabled: true, transport: { kind: "stdio", command } }] };
  return tree;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "doctor-")); out = ""; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("atag doctor (ATO-577)", () => {
  it("says per constrained folder what it allows and what is not policed (issue #33)", async () => {
    const tree = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, any>;
    tree.projects = { roots: [], constraints: { "/work/client": { allowedProviders: ["local-llama"], allowedEgress: ["github"] }, "/work/other": { allowedProviders: [] } } };
    save(tree);
    expect(await run([])).toBe(0);
    expect(out).toContain("ok    project-constraints: /work/client restricted to: local-llama; egress allowed: github; best effort for shell commands (os.shell.run and verify.run refuse known network clients; scripts and other programs still open their own sockets); not covered: skill scripts and the network use of stdio MCP servers");
    expect(out).toContain("project-constraints: /work/other restricted to: no provider; egress allowed: none;");
  });

  it("reports memory rows retro-tagged with a folder's constraint and untagged profile facts (issue #33)", async () => {
    const tree = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, any>;
    tree.projects = { roots: [], constraints: { "/work/client": { allowedProviders: ["local-llama"] } } };
    save(tree);
    const dbFile = join(dir, "memory.sqlite");
    const notes = new MemoryStore({ dbFile, maxEntries: 100 });
    const profile = new ProfileStore({ dbFile });
    try {
      notes.store({ content: "tagged earlier", workingDir: "/work/client" });
      const policy = makeProviderPolicy({ key: "/work/client", allowedProviders: ["local-llama"], matchedDir: "/work/client" });
      backfillConstraintScopes(notes.getDatabaseHandleForEmbeddings(), (d) => (d.startsWith("/work/client") ? policy : undefined));
      notes.store({ content: "written since", workingDir: "/work/client/app" });
      notes.store({ content: "open", workingDir: "/work/open" });
      profile.set("editor", "vim");
    } finally {
      notes.close();
      profile.close();
    }
    expect(await run([])).toBe(0);
    expect(out).toContain("ok    memory-constraint-scope: 1 memory row retro-tagged with its folder's constraint; 1 untagged row under a constraint now (tagged at the next start)");
    expect(out).toMatch(/warn {2}memory-constraint-scope: 1 profile fact is untagged/);
  });

  it("warns about an unknown key and an unconfigured provider in projects.constraints (issue #33)", async () => {
    const tree = structuredClone(USER_CONFIG_DEFAULTS) as Record<string, any>;
    tree.projects = { roots: [], constraints: { "/work/client": { allowedProviders: ["local-llama", "ghost"], allowedProvidres: [] } } };
    save(tree);
    expect(await run([])).toBe(0);
    expect(out).toMatch(/warn {2}project-constraints: .*\["\/work\/client"\] has unknown key "allowedProvidres" \(ignored\); did you mean "allowedProviders"\?/);
    expect(out).toMatch(/warn {2}project-constraints: .*allows provider "ghost", which is not configured/);
  });

  it("a valid config is ok and exits 0", async () => {
    save(USER_CONFIG_DEFAULTS);
    expect(await run([])).toBe(0);
    expect(out).toMatch(/ok +config: .* is valid/);
  });

  it("broken JSON fails with no fix and is left alone", async () => {
    writeFileSync(cfgPath(), "{ not json");
    expect(await run(["--fix"])).toBe(1);
    expect(out).toMatch(/FAIL {2}config: .*not valid JSON/);
    expect(readFileSync(cfgPath(), "utf8")).toBe("{ not json");
  });

  it("an unknown active provider is offered a fix, which --fix applies with a backup that --undo restores", async () => {
    save(withBrokenActiveProvider());
    expect(await run([])).toBe(1);
    expect(out).toContain('set llm.activeTextProvider to "local-llama"');
    expect(read().llm.activeTextProvider).toBe("gone");

    out = "";
    expect(await run(["--fix"])).toBe(0);
    expect(read().llm.activeTextProvider).toBe("local-llama");
    expect(out).toMatch(/backed up config.json to .*doctor-backups/);
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);

    out = "";
    expect(await run(["--undo"])).toBe(0);
    expect(read().llm.activeTextProvider).toBe("gone");
    expect(await run(["--undo"])).toBe(1);
  });

  it("an enabled MCP server whose command is missing is turned off by --fix", async () => {
    save(withMcp("definitely-not-installed-cmd"));
    expect(await run([], () => false)).toBe(0);
    expect(out).toMatch(/warn {2}mcp: files: command "definitely-not-installed-cmd" is not installed/);
    await run(["--fix"], () => false);
    expect(read().mcp.servers[0].enabled).toBe(false);
  });

  it("an installed MCP command is ok and nothing is written", async () => {
    save(withMcp("npx"));
    const before = readFileSync(cfgPath(), "utf8");
    await run(["--fix"], (c) => c === "npx");
    expect(readFileSync(cfgPath(), "utf8")).toBe(before);
    expect(out).toContain("mcp: files: npx found");
  });

  it.skipIf(process.platform === "win32")("a config readable by others is chmod 600 by --fix", async () => {
    save(USER_CONFIG_DEFAULTS);
    chmodSync(cfgPath(), 0o644);
    await run([]);
    expect(out).toMatch(/warn {2}config-mode: config.json is mode 644/);
    await run(["--fix"]);
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600);
  });

  it("an unreadable session pin file is reported with the file and its fix", async () => {
    save(USER_CONFIG_DEFAULTS);
    writeFileSync(join(dir, "webhook-sessions.json"), "{ half");
    expect(await run([])).toBe(0);
    expect(out).toMatch(/warn {2}session-pins: could not read webhooks session pins from .*webhook-sessions\.json \(parse\)/);
    expect(out).toContain("session retention skips its prune every start");
    expect(out).toContain("is not valid JSON");
  });

  it("readable or missing session pin files are not reported", async () => {
    save(USER_CONFIG_DEFAULTS);
    writeFileSync(join(dir, "webhook-sessions.json"), '{"deploy":"s1"}');
    await run([]);
    expect(out).not.toContain("session-pins");
  });

  it("an unknown option is a usage error", async () => {
    expect(await run(["--fxi"])).toBe(2);
  });
});

describe("atag doctor --json", () => {
  it("--fix --json prints only the findings on stdout", async () => {
    save(withBrokenActiveProvider());
    let err = "";
    await doctorCommand(["--fix", "--json"], { stateDir: dir, write, engine: null, writeErr: (t) => { err += t; }, context: { findOnPath: () => true } });
    expect(Array.isArray(JSON.parse(out))).toBe(true);
    expect(err).toMatch(/backed up config.json/);
  });

  it("a server already off as \"false\" is not reported", async () => {
    const tree = withMcp("definitely-not-installed-cmd");
    tree.mcp.servers[0].enabled = "false";
    save(tree);
    await run([], () => false);
    expect(out).not.toContain("not installed");
  });

});

describe("atag doctor sqlite check (issue #29)", () => {
  it("reports a better-sqlite3 that cannot open a database, with the loader's fix", async () => {
    save(USER_CONFIG_DEFAULTS);
    const code = await doctorCommand([], {
      stateDir: dir, write, engine: null,
      context: {
        findOnPath: () => true,
        openSqlite: () => { throw new Error("better-sqlite3's native binding is missing; reinstall the dependencies with npm ci"); },
      },
    });
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL {2}sqlite: .*npm ci/);
  });

  it("an in-memory database that opens is ok", async () => {
    save(USER_CONFIG_DEFAULTS);
    expect(await run([])).toBe(0);
    expect(out).toMatch(/ok +sqlite: better-sqlite3 opens a database/);
  });

  it("names the better-sqlite3 version, SQLite version and the binding it loaded", async () => {
    save(USER_CONFIG_DEFAULTS);
    expect(await run([])).toBe(0);
    expect(out).toMatch(/ok +sqlite: better-sqlite3 opens a database \(better-sqlite3 \d+\.\d+\.\d+, SQLite \d+\.\d+\.\d+, (prebuilt|compiled) binding [^)]+\)/);
  });
});

describe("describeBetterSqliteBinding (issue #29)", () => {
  const pkg = "/pkg";
  it("prefers a locally compiled binding, as better-sqlite3 itself does", () => {
    const exists = (p: string) => p === join(pkg, "build", "Release", "better_sqlite3.node") || p === join(pkg, "prebuilds", "win32-x64.node");
    expect(describeBetterSqliteBinding(pkg, "win32", "x64", exists)).toBe("compiled binding build/Release/better_sqlite3.node");
  });
  it("otherwise names the prebuilt N-API binary for this platform", () => {
    const exists = (p: string) => p === join(pkg, "prebuilds", "win32-x64.node");
    expect(describeBetterSqliteBinding(pkg, "win32", "x64", exists)).toBe("prebuilt binding prebuilds/win32-x64.node");
  });
  it("says so when neither exists", () => {
    expect(describeBetterSqliteBinding(pkg, "linux", "x64", () => false)).toBe("no binding file found");
  });
});

describe("atag doctor support id (ATO-1466)", () => {
  const ID = "11111111-2222-4333-8444-555555555555";

  it("ends the text output with the support id", async () => {
    save(USER_CONFIG_DEFAULTS);
    await doctorCommand([], { stateDir: dir, write, engine: null, context: { findOnPath: () => true }, supportId: () => ID });
    expect(out).toContain(`support id: ${ID}`);
  });

  it("says none yet without an id, and keeps --json to the findings alone", async () => {
    save(USER_CONFIG_DEFAULTS);
    await doctorCommand([], { stateDir: dir, write, engine: null, context: { findOnPath: () => true }, supportId: () => null });
    expect(out).toContain("support id: none yet");
    out = "";
    await doctorCommand(["--json"], { stateDir: dir, write, engine: null, context: { findOnPath: () => true }, supportId: () => ID });
    expect(out).not.toContain(ID);
    expect(Array.isArray(JSON.parse(out))).toBe(true);
  });
});
