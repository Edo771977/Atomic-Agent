import { describe, expect, it } from "vitest";
import { readTaintTargets } from "./read-taint-targets.js";

const wd = "/work/open";

describe("readTaintTargets", () => {
  it("reads verify.run commands like the shell: cwd and absolute paths", () => {
    expect(readTaintTargets("verify.run", { kind: "test", cmd: "cat", args: ["/work/secret/plan.md"] }, wd))
      .toContain("/work/secret/plan.md");
    expect(readTaintTargets("verify.run", { kind: "test", cmd: "npm", args: ["test"], cwd: "../secret" }, wd))
      .toContain("/work/secret");
    expect(readTaintTargets("verify.run", { kind: "server", start: { cmd: "node", args: ["/work/secret/s.js"] } }, wd))
      .toContain("/work/secret/s.js");
  });

  it("reads a stdin script fed to a shell, not stdin data to a plain command", () => {
    expect(readTaintTargets("verify.run", { kind: "command", cmd: "sh", stdin: "cat /work/secret/plan.md" }, wd))
      .toContain("/work/secret/plan.md");
    expect(readTaintTargets("verify.run", { kind: "command", cmd: "cat", stdin: "/work/secret/plan.md" }, wd))
      .not.toContain("/work/secret/plan.md");
  });

  it("resolves a climbing relative shell path against the cwd", () => {
    expect(readTaintTargets("os.shell.run", { cmd: "cat ../secret/plan.md" }, wd)).toContain("/work/secret/plan.md");
  });

  it("covers content-returning tools the read scope does not list", () => {
    expect(readTaintTargets("os.fs.archive.extract", { path: "/work/secret/a.zip", destDir: "/tmp/x" }, wd))
      .toContain("/work/secret/a.zip");
    expect(readTaintTargets("os.fs.edit", { path: "/work/secret/a.ts", oldString: "a", newString: "b" }, wd))
      .toContain("/work/secret/a.ts");
    expect(readTaintTargets("os.fs.patch", { patchPath: "/work/secret/p.diff", rootDir: "/work/secret" }, wd))
      .toEqual(expect.arrayContaining(["/work/secret/p.diff", "/work/secret"]));
    expect(readTaintTargets("os.fs.restore", { path: "/work/secret/a.ts" }, wd)).toContain("/work/secret/a.ts");
    for (const tool of ["os.git.add", "os.git.commit", "os.git.checkout", "os.git.remote", "os.git.push", "os.git.pull", "os.git.fetch"]) {
      expect(readTaintTargets(tool, { repo: "/work/secret" }, wd)).toContain("/work/secret");
    }
  });

  it("taints a write of a file a language server diagnoses (its result can quote the project, ATO-503)", () => {
    const lsp = { lspWrites: true };
    expect(readTaintTargets("os.fs.write", { path: "/work/secret/a.ts", content: "x" }, wd, lsp)).toEqual(["/work/secret/a.ts"]);
    expect(readTaintTargets("os.fs.write", { path: "../secret/b.py", content: "x" }, wd, lsp)).toEqual(["/work/secret/b.py"]);
    // No language server reads a note: nothing comes back to taint.
    expect(readTaintTargets("os.fs.write", { path: "/work/secret/notes.md", content: "x" }, wd, lsp)).toEqual([]);
  });

  it("does not taint a write when no language server was built (tools.lsp.enabled off)", () => {
    expect(readTaintTargets("os.fs.write", { path: "/work/secret/a.ts", content: "x" }, wd)).toEqual([]);
    expect(readTaintTargets("os.fs.write", { path: "/work/secret/a.ts", content: "x" }, wd, { lspWrites: false })).toEqual([]);
    // An edit still returns a diff: it taints either way.
    expect(readTaintTargets("os.fs.edit", { path: "/work/secret/a.ts", oldString: "a", newString: "b" }, wd)).toEqual(["/work/secret/a.ts"]);
  });
});
