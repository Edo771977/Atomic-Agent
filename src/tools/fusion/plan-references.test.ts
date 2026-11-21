import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRipgrepPath } from "../../runtime/ripgrep-resolver.js";
import { runCommand, type CommandResult } from "../../sandbox/command-runner.js";
import type { AssignmentRow } from "../../session/session-project.js";
import type { ContractCheck } from "./contract.js";
import { checkPlanReferences, extractPlanReferences, type PlanReferenceDeps } from "./plan-references.js";

const row = (taskId: string, title: string, checks?: ContractCheck[]): AssignmentRow => ({
  taskId, title, milestoneId: "m1", worker: "local:model", reviewer: null, reason: "preset", basis: "preset", samples: 0, estCostUsd: null, estMs: null,
  ...(checks === undefined ? {} : { checks }),
});
const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "plan-refs-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, ...rel.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...rel.split("/")), text);
  }
  return root;
}
const result = (stdout: string, extra: Partial<CommandResult> = {}): CommandResult => ({
  command: "rg", args: [], exitCode: 0, signal: null, stdout, stderr: "", durationMs: 1, timedOut: false, truncated: false, inputTruncated: false, ...extra,
});
const noRg: Partial<PlanReferenceDeps> = { resolveRgPath: () => null, env: { PATH: "" } };
const outcome = (refs: ReadonlyArray<{ value: string; outcome: string }>, value: string) => refs.find((r) => r.value === value)?.outcome;

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("plan references (issue #120)", () => {
  it("reports a cited file that does not exist, unless a task of the plan creates it", async () => {
    const root = project({ "src/app.ts": "export const app = 1;\n" });
    const rows = [
      row("t1", "Wire src/foo/bar.ts into src/app.ts"),
      row("t2", "Create src/made/new.ts and src/made/other.ts, then update src/ghost.ts"),
      row("t3", "Use src/made/new.ts from src/made/other.ts"),
    ];
    const report = await checkPlanReferences(rows, { root, deps: noRg });
    expect(outcome(report.references, "src/foo/bar.ts")).toBe("missing");
    expect(outcome(report.references, "src/app.ts")).toBe("verified");
    expect(outcome(report.references, "src/ghost.ts")).toBe("missing");
    expect(report.references.some((r) => r.value.startsWith("src/made/"))).toBe(false);
    expect(report.declared).toBe(2);
    expect(report.record.verdict).toBe("warn");
    expect(report.record.detail).toMatch(/Missing: src\/foo\/bar\.ts \(t1: not in the project folder\), src\/ghost\.ts \(t2/);
    expect(report.record.taskIds).toEqual(["t1", "t2"]);
  });

  it("flags a check's npm script that package.json does not define, and a command found nowhere", async () => {
    const root = project({ "package.json": JSON.stringify({ scripts: { test: "vitest", build: "tsc" } }), "web/package.json": "{}" });
    const rows = [
      row("t1", "Tests", [{ cmd: "npm", args: ["run", "test:xyz"] }, { cmd: "npm test" }, { cmd: "npm", args: ["--prefix", "web", "run", "build"] }]),
      row("t2", "Lint with `pnpm lint:all`", [{ cmd: "no-such-tool-9f2", args: ["src/a.ts"] }]),
      row("t3", "Add the `lint:new` script to package.json, then run `npm run lint:new`"),
    ];
    const report = await checkPlanReferences(rows, { root, deps: noRg });
    const script = (v: string, dir = "") => report.references.find((r) => r.kind === "script" && r.value === v && (r.dir ?? "") === dir)?.outcome;
    expect(script("test:xyz")).toBe("missing");
    expect(script("test")).toBe("verified");
    expect(script("build", "web")).toBe("missing");
    expect(script("lint:all")).toBe("missing");
    expect(report.references.some((r) => r.value === "lint:new")).toBe(false);
    expect(report.references.find((r) => r.kind === "command" && r.value === "no-such-tool-9f2")?.outcome).toBe("missing");
    expect(report.record.detail).toContain("npm script test:xyz (t1: no such script in package.json)");
    expect(report.record.detail).toContain("npm script build (t1: no such script in web/package.json)");
  });

  it("resolves a check's command in node_modules/.bin or on PATH, and shell builtins", async () => {
    const root = project({ "node_modules/.bin/vitest": "", "bin/tool": "" });
    const rows = [row("t1", "Run", [{ cmd: "vitest" }, { cmd: "tool" }, { cmd: "echo hi" }, { cmd: "./scripts/run.sh" }])];
    const report = await checkPlanReferences(rows, { root, deps: { resolveRgPath: () => null, env: { PATH: join(root, "bin") } } });
    expect(outcome(report.references, "vitest")).toBe("verified");
    expect(outcome(report.references, "tool")).toBe("verified");
    expect(outcome(report.references, "echo")).toBe("verified");
    expect(outcome(report.references, "scripts/run.sh")).toBe("missing");
  });

  it("never runs a project command and never uses the network: ripgrep is the only process", async () => {
    const root = project({ "evil.js": "require('fs').writeFileSync(__dirname + '/ran', 'x')\n", "src/a.ts": "export function realThing() {}\n" });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    const rg = resolveRipgrepPath();
    const calls: string[] = [];
    const spy: PlanReferenceDeps["runCommand"] = async (command, args, options) => {
      calls.push(command);
      return rg === null ? result("") : runCommand(command, args, options);
    };
    const rows = [row("t1", "Use `realThing` and `ghostThing` in `evil.js`", [
      { cmd: "node", args: ["evil.js"] }, { cmd: "sh -c 'node evil.js'" }, { cmd: "curl https://example.invalid" }, { kind: "page", path: "index.html" },
    ])];
    const report = await checkPlanReferences(rows, { root, deps: { runCommand: spy, resolveRgPath: () => rg ?? "/fake/rg" } });
    expect(existsSync(join(root, "ran"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c === (rg ?? "/fake/rg"))).toBe(true);
    expect(outcome(report.references, "index.html")).toBe("missing");
    if (rg !== null) {
      expect(outcome(report.references, "realThing")).toBe("verified");
      expect(outcome(report.references, "ghostThing")).toBe("missing");
      expect(outcome(report.references, "evil.js")).toBe("verified");
    }
  });

  it("finds symbols with one search, keeps symbols a task adds, and reads several same-named files as ambiguous", async () => {
    const root = project({ "a/game.js": "", "b/game.js": "", "src/x.ts": "" });
    const runs: string[][] = [];
    const run: PlanReferenceDeps["runCommand"] = async (_c, args) => {
      runs.push(args);
      return args.includes("--files") ? result("a/game.js\nb/game.js\nsrc/x.ts\n") : result("parseScore\nparseScore\n");
    };
    const rows = [
      row("t1", "Fix `parseScore()` and `Game.tick` in `game.js`"),
      row("t2", "Add a `newHelper` function to src/x.ts"),
      row("t3", "Call `newHelper` from `x.ts`"),
    ];
    const report = await checkPlanReferences(rows, { root, deps: { ...noRg, resolveRgPath: () => "/rg", runCommand: run } });
    expect(outcome(report.references, "parseScore")).toBe("verified");
    expect(outcome(report.references, "tick")).toBe("missing");
    expect(outcome(report.references, "game.js")).toBe("ambiguous");
    expect(outcome(report.references, "x.ts")).toBe("verified");
    expect(report.references.some((r) => r.value === "newHelper")).toBe(false);
    expect(runs.filter((a) => !a.includes("--files"))).toHaveLength(1);
    expect(report.record.detail).toMatch(/Ambiguous: game\.js \(t1: 2 files have that name: a\/game\.js, b\/game\.js\)/);
  });

  it("over the time limit, references are uncheckable and the line says so: never green", async () => {
    const root = project({ "src/a.ts": "" });
    let t = 0;
    const slow = await checkPlanReferences([row("t1", "Edit src/a.ts and src/b.ts and `someSymbol`")], {
      root, limits: { maxMs: 2_000 }, deps: { ...noRg, now: () => (t += 2_500) },
    });
    expect(slow.references.every((r) => r.outcome === "uncheckable")).toBe(true);
    expect(slow.record.verdict).toBe("warn");
    expect(slow.record.detail).toMatch(/3 references not checked: src\/a\.ts \(time limit \(2000 ms\)\)/);
    const timedOut = await checkPlanReferences([row("t1", "Fix `someSymbol`")], {
      root, deps: { ...noRg, resolveRgPath: () => "/rg", runCommand: async (_c, args) => args.includes("--files") ? result("src/a.ts\n") : result("", { timedOut: true, exitCode: null }) },
    });
    expect(timedOut.references[0]).toMatchObject({ outcome: "uncheckable", why: expect.stringMatching(/time limit/) });
    expect(timedOut.record).toMatchObject({ verdict: "warn", detail: expect.stringContaining("1 reference not checked") });
  });

  it("a folder over the size limit leaves symbols and bare names uncheckable; extra references are over the limit", async () => {
    const root = project({});
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`).join("\n");
    const big = await checkPlanReferences([row("t1", "Fix `someSymbol` in `main.ts`")], {
      root, limits: { maxFiles: 10 }, deps: { ...noRg, resolveRgPath: () => "/rg", runCommand: async () => result(many) },
    });
    expect(big.references.map((r) => r.outcome)).toEqual(["uncheckable", "uncheckable"]);
    expect(big.record.detail).toContain("folder too large (over 10 files)");
    const capped = await checkPlanReferences([row("t1", "Edit lib/a.ts lib/b.ts lib/c.ts")], { root, limits: { maxReferences: 2 }, deps: noRg });
    expect(capped.references.map((r) => r.outcome)).toEqual(["missing", "missing", "uncheckable"]);
    expect(capped.record.detail).toContain("lib/c.ts (over the limit of 2 references)");
  });

  it("reads Windows paths: backslashes, drive letters, case-insensitive names and PATHEXT", async () => {
    const files = new Set(["c:\\proj\\src\\foo\\bar.ts", "c:\\proj\\node_modules\\.bin\\tsc.cmd"]);
    const deps: Partial<PlanReferenceDeps> = {
      platform: "win32", env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" }, resolveRgPath: () => null,
      statPath: async (p) => (files.has(p.toLowerCase()) ? "file" : null), realPath: async (p) => p,
    };
    const rows = [
      row("t1", "Update src\\Foo\\Bar.ts and C:\\proj\\src\\foo\\BAR.ts; read D:\\elsewhere\\x.ts", [{ cmd: "tsc", args: ["-p", "."] }]),
      row("t2", "Create SRC\\New\\Thing.ts"),
      row("t3", "Import src/new/thing.ts in src\\missing.ts"),
    ];
    const extracted = extractPlanReferences(rows, "C:\\proj", "win32");
    expect(extracted.references.filter((r) => r.kind === "file").map((r) => r.value)).toEqual(["src/Foo/Bar.ts", "D:/elsewhere/x.ts", "src/new/thing.ts", "src/missing.ts"]);
    const report = await checkPlanReferences(rows, { root: "C:\\proj", deps });
    expect(outcome(report.references, "src/Foo/Bar.ts")).toBe("verified");
    expect(outcome(report.references, "D:/elsewhere/x.ts")).toBe("uncheckable");
    expect(outcome(report.references, "tsc")).toBe("verified");
    expect(outcome(report.references, "src/missing.ts")).toBe("missing");
    expect(report.references.some((r) => r.value === "src/new/thing.ts")).toBe(false);
  });

  it("reads a plan that cites nothing as a pass", async () => {
    const report = await checkPlanReferences([row("t1", "Make it nicer")], { root: project({}), deps: noRg });
    expect(report.record).toMatchObject({ verdict: "pass", detail: "The plan cites no file, script, command or symbol.", taskIds: [] });
  });

  it("finds a symbol in a file where another symbol already matched many lines (review #1)", async () => {
    const root = project({ "a.ts": "Alpha\nAlpha\nAlpha\nAlpha\nAlpha\nexport function Betaxx() {}\n" });
    const rg = resolveRipgrepPath();
    // Without ripgrep here, a runner shaped like it: --max-count caps matching lines per file over all patterns.
    const shaped: PlanReferenceDeps["runCommand"] = async (_c, args) => args.includes("--files") ? result("a.ts\n")
      : result(args.includes("--max-count") ? "Alpha\nAlpha\nAlpha\nAlpha\nAlpha\n" : "Alpha\nAlpha\nAlpha\nAlpha\nAlpha\nBetaxx\n");
    const report = await checkPlanReferences([row("t1", "Use `Alpha` and `Betaxx`")], {
      root, deps: { ...noRg, resolveRgPath: () => rg ?? "/rg", ...(rg === null ? { runCommand: shaped } : {}) },
    });
    expect(outcome(report.references, "Alpha")).toBe("verified");
    expect(outcome(report.references, "Betaxx")).toBe("verified");
  });

  it("says a symbol or bare name ripgrep did not search is not found outside ignored, hidden or large files (review #2)", async () => {
    const root = project({ ".gitignore": "dist\n", "dist/gen.ts": "export const Gammaxx = 1;\n", "src/a.ts": "" });
    const run: PlanReferenceDeps["runCommand"] = async (_c, args) => args.includes("--files") ? result("src/a.ts\n") : result("", { exitCode: 1 });
    const report = await checkPlanReferences([row("t1", "Use `Gammaxx` from `gen.ts`")], { root, deps: { ...noRg, resolveRgPath: () => "/rg", runCommand: run } });
    expect(report.references.find((r) => r.value === "Gammaxx")).toMatchObject({ outcome: "missing", why: "not found outside ignored, hidden or >1 MB files" });
    expect(report.references.find((r) => r.value === "gen.ts")).toMatchObject({ outcome: "missing", why: "no file of that name outside ignored or hidden files" });
    expect(report.record.verdict).toBe("warn");
  });

  it("resolves a check's cwd exactly, as a folder of the project (review #3)", async () => {
    const root = project({ "web/index.html": "", "other/sub/x.txt": "" });
    const run = vi.fn<PlanReferenceDeps["runCommand"]>(async () => result("other/sub/x.txt\n"));
    const report = await checkPlanReferences([row("t1", "Run", [{ cmd: "echo", cwd: "sub" }, { cmd: "echo", cwd: "web" }])], {
      root, deps: { ...noRg, resolveRgPath: () => "/rg", runCommand: run },
    });
    expect(report.references.find((r) => r.value === "sub")).toMatchObject({ kind: "file", dir: "", outcome: "missing", why: "not in the project folder" });
    expect(outcome(report.references, "web")).toBe("verified");
    expect(run).not.toHaveBeenCalled();
  });

  it("never joins an absolute package folder or a drive-relative cwd under the check's cwd (review #4)", () => {
    const rows = [row("t1", "Run", [{ cmd: "npm", args: ["--prefix", "/etc", "run", "y"], cwd: "sub" }, { cmd: "npm", args: ["-C", "D:\\pkg", "run", "z"], cwd: "sub" }])];
    const posixRefs = extractPlanReferences(rows, "/proj", "linux").references;
    expect(posixRefs.find((r) => r.kind === "script" && r.value === "y")).toMatchObject({ reason: "its package folder is outside the project folder (not read)" });
    const winRefs = extractPlanReferences([...rows, row("t2", "Run", [{ cmd: "ls", cwd: "C:foo" }])], "C:\\proj", "win32").references;
    expect(winRefs.find((r) => r.kind === "script" && r.value === "z")).toMatchObject({ reason: "its package folder is outside the project folder (not read)" });
    expect(winRefs.find((r) => r.kind === "script" && r.value === "y")).toMatchObject({ reason: "its package folder is outside the project folder (not read)" });
    expect(winRefs.find((r) => r.value === "C:foo")).toMatchObject({ kind: "file", reason: "outside the project folder (not read)" });
  });

  it("never reads or stats through a symlink that leads outside the project folder (review #5)", async (t) => {
    const outside = project({ "secret.txt": "x", "package.json": JSON.stringify({ scripts: { deploy: "x" } }), "node_modules/.bin/outtool": "" });
    const root = project({ "package.json": JSON.stringify({ scripts: {} }) });
    try {
      symlinkSync(outside, join(root, "link"), "dir");
      symlinkSync(join(outside, "node_modules"), join(root, "node_modules"), "dir");
    } catch {
      t.skip();
      return;
    }
    const reads: string[] = [];
    const rows = [
      row("t1", "Touch link/secret.txt and link/nothere.txt"),
      row("t2", "x", [{ cmd: "npm run deploy", cwd: "link" }, { cmd: "outtool", cwd: "link" }, { cmd: "outtool" }]),
    ];
    const report = await checkPlanReferences(rows, { root, deps: { resolveRgPath: () => null, env: { PATH: "" }, readText: async (p) => { reads.push(p); return null; } } });
    const find = (kind: string, value: string, dir?: string) => report.references.find((r) => r.kind === kind && r.value === value && (dir === undefined || r.dir === dir));
    expect(find("file", "link/secret.txt")?.outcome).toBe("uncheckable");
    expect(find("file", "link/nothere.txt")).toMatchObject({ outcome: "uncheckable", why: "it leads outside the project folder" });
    expect(find("script", "deploy", "link")).toMatchObject({ outcome: "uncheckable", why: "its folder leads outside the project folder (not read)" });
    expect(find("command", "outtool", "link")).toMatchObject({ outcome: "uncheckable", why: "its folder leads outside the project folder (not read)" });
    expect(find("command", "outtool", "")).toMatchObject({ outcome: "uncheckable", why: "node_modules/.bin leads outside the project folder" });
    expect(reads).toEqual([]);
  });
});

