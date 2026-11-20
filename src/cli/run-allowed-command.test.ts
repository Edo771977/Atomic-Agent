import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../approval/approval-gate.js";
import { allowedCommandMatches, parseAllowedCommand } from "./run-allowed-command.js";

/** Issue #95: `run --allow-command "<exact command>"`. */
describe("parseAllowedCommand", () => {
  it("takes one plain command and keeps its words", () => {
    expect(parseAllowedCommand("node --test sales.test.cjs")).toEqual({ argv: ["node", "--test", "sales.test.cjs"] });
    expect(parseAllowedCommand("  node   --test  ")).toEqual({ argv: ["node", "--test"] });
  });

  it("refuses an empty line and any shell syntax rather than guessing how a shell would read it", () => {
    for (const bad of ["", "   ", "node a.cjs && rm -rf x", "npm test; curl x", "echo rm | sh", `node -e "x"`, "node --test > out",
      "node --test &", "node --test # x", "node *.cjs", "node $HOME", "node ~/x", "node %PATH%", "node a^&b"]) {
      expect(parseAllowedCommand(bad)).toHaveProperty("error");
    }
  });
});

describe("allowedCommandMatches", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aa-allow-root-")));
  mkdirSync(join(root, "pkg"));
  const sibling = `${root}-other`;
  mkdirSync(sibling, { recursive: true });
  const allowed = [parseAllowedCommand("node --test sales.test.cjs") as { argv: string[] }];
  const shell = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    approvalId: "a1", sessionId: "s1", tool: "os.shell.run", category: "shell", reason: "r",
    literalExec: true, commandArgv: ["node", "--test", "sales.test.cjs"],
    commandSegments: [["node", "--test", "sales.test.cjs"]], affectedResources: [root], workdir: root,
    ...over,
  });

  it("matches the exact command in the run's folder or below", () => {
    expect(allowedCommandMatches(shell(), allowed, root)).toBe(true);
    expect(allowedCommandMatches(shell({ affectedResources: [join(root, "pkg")] }), allowed, root)).toBe(true);
  });

  it("takes argv[0] exactly as written: no path when the value has none, case kept on POSIX", () => {
    for (const first of ["/usr/bin/NODE", "./node", "/tmp/x/node", "NODE", "node.exe", "bin/node"]) {
      expect(allowedCommandMatches(shell({ commandArgv: [first, "--test", "sales.test.cjs"] }), allowed, root, "linux")).toBe(false);
    }
    const withPath = [parseAllowedCommand("./node_modules/.bin/vitest run") as { argv: string[] }];
    expect(allowedCommandMatches(shell({ commandArgv: ["./node_modules/.bin/vitest", "run"] }), withPath, root, "linux")).toBe(true);
    expect(allowedCommandMatches(shell({ commandArgv: ["node_modules/.bin/vitest", "run"] }), withPath, root, "linux")).toBe(false);
  });

  it("on Windows folds case but still allows no path", () => {
    expect(allowedCommandMatches(shell({ commandArgv: ["NODE", "--test", "sales.test.cjs"] }), allowed, root, "win32")).toBe(true);
    for (const first of [".\\node", "C:\\tools\\node", "./node"]) {
      expect(allowedCommandMatches(shell({ commandArgv: [first, "--test", "sales.test.cjs"] }), allowed, root, "win32")).toBe(false);
    }
    expect(allowedCommandMatches(shell({ commandArgv: ["node", "--TEST", "sales.test.cjs"] }), allowed, root, "win32")).toBe(false);
  });

  it("folds ASCII letters only, and matches nothing outside printable ASCII", () => {
    const kube = [parseAllowedCommand("kubectl get") as { argv: string[] }];
    // U+212A KELVIN SIGN lowercases to "k" under Unicode folding.
    expect(allowedCommandMatches(shell({ commandArgv: ["\u212Aubectl", "get"], commandSegments: [["\u212Aubectl", "get"]] }), kube, root, "win32")).toBe(false);
    expect(allowedCommandMatches(shell({ commandArgv: ["KUBECTL", "get"] }), kube, root, "win32")).toBe(true);
    expect(parseAllowedCommand("node t\u00e9st.cjs")).toHaveProperty("error");
    expect(parseAllowedCommand("node\u00a0--test")).toHaveProperty("error");
  });

  it("does not match another command, more or fewer words, a shell line, or a call that writes a file", () => {
    expect(allowedCommandMatches(shell({ commandArgv: ["node", "--test", "other.test.cjs"] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ commandArgv: ["node", "--test", "sales.test.cjs", "--watch"] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ commandArgv: ["node", "--test"] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ literalExec: undefined }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ commandArgv: undefined }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ commandUnreadable: true }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ targetPaths: [join(root, "out.txt")] }), allowed, root)).toBe(false);
  });

  it("does not match outside the run's folder", () => {
    expect(allowedCommandMatches(shell({ affectedResources: [dirname(root)] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ affectedResources: [sibling] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ affectedResources: [] }), allowed, root)).toBe(false);
  });

  it("compares real paths: a link out of the folder does not match, and a folder that cannot be resolved fails closed", () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "aa-allow-real-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "aa-allow-out-")));
    symlinkSync(outside, join(real, "link"), "dir");
    expect(allowedCommandMatches(shell({ affectedResources: [real] }), allowed, real)).toBe(true);
    expect(allowedCommandMatches(shell({ affectedResources: [join(real, "link")] }), allowed, real)).toBe(false);
    expect(allowedCommandMatches(shell({ affectedResources: [join(real, "missing")] }), allowed, real)).toBe(false);
    expect(allowedCommandMatches(shell({ affectedResources: [real] }), allowed, join(real, "missing"))).toBe(false);
  });

  it("does not match a dangerous command, another category or another tool", () => {
    expect(allowedCommandMatches(shell({ category: "shell_dangerous" }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ category: "verify_page_local" }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ tool: "os.fs.write", category: "fs_write_workspace" }), allowed, root)).toBe(false);
  });

  it("matches verify.run only for a plain command check (no env, no stdin, one command)", () => {
    expect(allowedCommandMatches(shell({ tool: "verify.run" }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ tool: "verify.run", verifyPlainCommand: true }), allowed, root)).toBe(true);
  });

  it("matches nothing when no command was allowed", () => {
    expect(allowedCommandMatches(shell(), [], root)).toBe(false);
  });
});

describe("verify.run checks built from real specs (issue #95 review)", () => {
  const ask = async (spec: Record<string, unknown>, workingDir: string): Promise<ApprovalRequest> => {
    const { authorizeVerifyBatch } = await import("../tools/verify/verify-authorization.js");
    const seen: ApprovalRequest[] = [];
    const approvals = { request: async (req: ApprovalRequest) => { seen.push(req); return { approvalId: "x", approved: true }; } };
    await authorizeVerifyBatch([spec], { approvals: approvals as never, approvalRequired: true }, { sessionId: "s", workingDir, stepIndex: 0, signal: new AbortController().signal } as never);
    return seen[0]!;
  };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aa-allow-verify-")));
  const allowedTest = [parseAllowedCommand("node --test") as { argv: string[] }];

  it("matches the plain direct command", async () => {
    expect(allowedCommandMatches(await ask({ kind: "command", cmd: "node", args: ["--test"] }, dir), allowedTest, dir)).toBe(true);
  });

  it.each([
    ["a redirect", "node --test > /tmp/evil-out"],
    ["an appending redirect", "node --test >> ~/.bashrc"],
    ["a comment", "node --test # & calc.exe"],
    ["a background job", "node --test &"],
  ])("holds a command line with %s", async (_label, line) => {
    expect(allowedCommandMatches(await ask({ kind: "command", cmd: line }, dir), allowedTest, dir)).toBe(false);
  });
});
