import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isShellHttpUrl } from "./read-scope-targets.js";
import { readTaintTargets } from "./read-taint-targets.js";
import { findShellStateSecrets } from "./state-secrets.js";

const wd = resolve("/work/open");
const plan = resolve("/work/secret/plan.md");
const source = resolve("/work/secret/a.ts");
const repo = resolve("/work/secret");

it.each([
  "https://example.test/../../../secret/plan.md",
  "data:fixture/../../secret/plan.md",
  "blob:fixture/../../secret/plan.md",
  "about:fixture/../../secret/plan.md",
])("treats climbing shell token %s as a path for taint and secret checks", token => {
  const args = { cmd: "cat", args: [token] };
  expect(readTaintTargets("os.shell.run", args, wd)).toContain(plan);
  expect(findShellStateSecrets(args, { workingDir: wd }, { stateDir: repo, files: [plan] })).toContain(plan);
});

it("leaves an ordinary HTTPS shell argument outside the filesystem guards", () => {
  const args = { cmd: "cat", args: ["https://example.test/resource"] };
  expect(readTaintTargets("os.shell.run", args, wd)).toEqual([]);
  expect(findShellStateSecrets(args, { workingDir: wd }, { stateDir: repo, files: [plan] })).toEqual([]);
});

it("checks the original HTTP path independently of its query and fragment", () => {
  expect(isShellHttpUrl("https://example.test/folder/..?view=fixture")).toBe(false);
  expect(isShellHttpUrl("https://example.test/folder/%2e.#fixture")).toBe(false);
  expect(isShellHttpUrl("https://example.test/folder?view=fixture#section")).toBe(true);
  expect(isShellHttpUrl("https://")).toBe(false);
});

it("distinguishes an HTTP URL's normalized spelling from the original shell operand", () => {
  const operand = "https://example.test/a/../report";
  expect(isShellHttpUrl(operand)).toBe(false);
  expect(isShellHttpUrl(new URL(operand).href)).toBe(true);
});

describe("readTaintTargets", () => {
  it("reads verify.run commands like the shell: cwd and absolute paths", () => {
    expect(readTaintTargets("verify.run", { kind: "test", cmd: "cat", args: [plan] }, wd)).toContain(plan);
    expect(readTaintTargets("verify.run", { kind: "test", cmd: "npm", args: ["test"], cwd: "../secret" }, wd))
      .toContain(resolve("/work/secret"));
    const server = resolve("/work/secret/s.js");
    expect(readTaintTargets("verify.run", { kind: "server", start: { cmd: "node", args: [server] } }, wd))
      .toContain(server);
  });

  it("reads a stdin script fed to a shell, not stdin data to a plain command", () => {
    const shellPath = plan.replaceAll("\\", "/");
    expect(readTaintTargets("verify.run", { kind: "command", cmd: "sh", stdin: `cat ${shellPath}` }, wd)).toContain(plan);
    expect(readTaintTargets("verify.run", { kind: "command", cmd: "cat", stdin: shellPath }, wd)).not.toContain(plan);
  });

  it("resolves a climbing relative shell path against the cwd", () => {
    expect(readTaintTargets("os.shell.run", { cmd: "cat ../secret/plan.md" }, wd)).toContain(plan);
  });

  it("covers content-returning tools the read scope does not list", () => {
    const archive = resolve("/work/secret/a.zip");
    const patch = resolve("/work/secret/p.diff");
    expect(readTaintTargets("os.fs.archive.extract", { path: archive, destDir: resolve("/tmp/x") }, wd)).toContain(archive);
    expect(readTaintTargets("os.fs.edit", { path: source, oldString: "a", newString: "b" }, wd)).toContain(source);
    expect(readTaintTargets("os.fs.patch", { patchPath: patch, rootDir: repo }, wd))
      .toEqual(expect.arrayContaining([patch, repo]));
    expect(readTaintTargets("os.fs.restore", { path: source }, wd)).toContain(source);
    for (const tool of ["os.git.add", "os.git.commit", "os.git.checkout", "os.git.remote", "os.git.push", "os.git.pull", "os.git.fetch"]) {
      expect(readTaintTargets(tool, { repo }, wd)).toContain(repo);
    }
  });

  it("taints a write of a file a language server diagnoses (its result can quote the project, ATO-503)", () => {
    const lsp = { lspWrites: true };
    expect(readTaintTargets("os.fs.write", { path: source, content: "x" }, wd, lsp)).toEqual([source]);
    expect(readTaintTargets("os.fs.write", { path: "../secret/b.py", content: "x" }, wd, lsp)).toEqual([resolve("/work/secret/b.py")]);
    // No language server reads a note: nothing comes back to taint.
    expect(readTaintTargets("os.fs.write", { path: resolve("/work/secret/notes.md"), content: "x" }, wd, lsp)).toEqual([]);
  });

  it("does not taint a write when no language server was built (tools.lsp.enabled off)", () => {
    expect(readTaintTargets("os.fs.write", { path: source, content: "x" }, wd)).toEqual([]);
    expect(readTaintTargets("os.fs.write", { path: source, content: "x" }, wd, { lspWrites: false })).toEqual([]);
    // An edit still returns a diff: it taints either way.
    expect(readTaintTargets("os.fs.edit", { path: source, oldString: "a", newString: "b" }, wd)).toEqual([source]);
  });
});

it("taints research link probes with the source document's folder", () => {
  expect(readTaintTargets("verify.run", { type: "research", cwd: "restricted", path: "sources.md", network: true }, wd))
    .toEqual([resolve(wd, "restricted", "sources.md")]);
});
