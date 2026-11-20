import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../approval/approval-gate.js";
import { allowedCommandMatches, parseAllowedCommand } from "./run-allowed-command.js";

/** Issue #95: `run --allow-command "<exact command>"`. */
describe("parseAllowedCommand", () => {
  it("takes one simple command and keeps its words", () => {
    expect(parseAllowedCommand("node --test sales.test.cjs")).toEqual({ argv: ["node", "--test", "sales.test.cjs"] });
    expect(parseAllowedCommand(`node -e "console.log('a b')"`)).toEqual({ argv: ["node", "-e", "console.log('a b')"] });
  });

  it("refuses an empty line, a compound line and a script fed to a shell", () => {
    for (const bad of ["", "   ", "node a.cjs && rm -rf x", "npm test; curl x", "echo rm | sh"]) {
      expect(parseAllowedCommand(bad)).toHaveProperty("error");
    }
  });
});

describe("allowedCommandMatches", () => {
  const root = join("/work", "proj");
  const allowed = [parseAllowedCommand("node --test sales.test.cjs") as { argv: string[] }];
  const shell = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
    approvalId: "a1", sessionId: "s1", tool: "os.shell.run", category: "shell", reason: "r",
    commandSegments: [["node", "--test", "sales.test.cjs"]], affectedResources: [root], workdir: root,
    ...over,
  });

  it("matches the exact command in the run's folder or below, argv[0] compared as a rule compares it", () => {
    expect(allowedCommandMatches(shell(), allowed, root)).toBe(true);
    expect(allowedCommandMatches(shell({ affectedResources: [join(root, "pkg")] }), allowed, root)).toBe(true);
    expect(allowedCommandMatches(shell({ commandSegments: [["/usr/bin/NODE", "--test", "sales.test.cjs"]] }), allowed, root)).toBe(true);
  });

  it("does not match another command, more or fewer words, or a compound line", () => {
    expect(allowedCommandMatches(shell({ commandSegments: [["node", "--test", "other.test.cjs"]] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ commandSegments: [["node", "--test", "sales.test.cjs", "--watch"]] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ commandSegments: [["node", "--test"]] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ commandSegments: [["node", "--test", "sales.test.cjs"], ["rm", "-rf", "x"]] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ commandUnreadable: true }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ commandSegments: undefined }), allowed, root)).toBe(false);
  });

  it("does not match outside the run's folder", () => {
    expect(allowedCommandMatches(shell({ affectedResources: ["/work"] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ affectedResources: [join("/work", "proj-other")] }), allowed, root)).toBe(false);
    expect(allowedCommandMatches(shell({ affectedResources: [] }), allowed, root)).toBe(false);
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
