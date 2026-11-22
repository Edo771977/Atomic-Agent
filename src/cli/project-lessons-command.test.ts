import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { resolveProjectConstraint } from "../config/project-constraint-match.js";
import { projectCommand } from "./projects-command.js";

describe("project lessons", () => {
  let root: string;
  const stdout = vi.fn<(text: string) => void>();
  const stderr = vi.fn<(text: string) => void>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "project-lessons-cli-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists only the requested constrained folder in JSON without writing personal state", async () => {
    const state = join(root, "state");
    const folder = join(root, "restricted");
    const other = join(root, "other");
    const configFile = join(state, "config.json");
    mkdirSync(state);
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", state);
    const config = JSON.stringify({ projects: { constraints: { [folder]: { allowedProviders: [] } } } });
    writeFileSync(configFile, config);
    resetConfigCache();
    for (const [project, id] of [[folder, "private-lesson"], [other, "other-lesson"]] as const) {
      const dir = join(project, ".atomic", "project", "lessons");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${id}.md`), [
        "---", `id: ${id}`, "title: Project decision", "source: person", "touches: [src/file.ts]",
        "status: active", "always: false", "---", "## Decided", "## Tried and ruled out", "## Watch out",
      ].join(EOL));
    }
    expect(resolveProjectConstraint(getConfig(), folder)?.allowedProviders).toEqual([]);
    const configBefore = readFileSync(configFile, "utf8");
    const before = readdirSync(state, { recursive: true }).sort();
    writeFileSync(join(folder, ".atomic", "project", "lessons", "broken.md"), "broken");
    expect(await projectCommand(["lessons", folder, "--json"], { stdout, stderr })).toBe(0);
    expect(JSON.parse(stdout.mock.calls[0]![0])).toEqual({
      lessons: [{
        id: "private-lesson", title: "Project decision", declaredStatus: "active",
        approvedByPerson: false, always: false, touches: ["src/file.ts"],
      }],
      problems: [{ file: "broken.md", reason: expect.stringMatching(/front matter/i) }],
    });
    expect(stderr).not.toHaveBeenCalled();
    expect(readdirSync(state, { recursive: true }).sort()).toEqual(before);
    expect(readFileSync(configFile, "utf8")).toBe(configBefore);
  });

  it("defaults to the current folder and reports skipped files in text", async () => {
    const dir = join(root, ".atomic", "project", "lessons");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.md"), "broken");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      expect(await projectCommand(["lessons"], { stdout, stderr })).toBe(0);
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Skipped "broken.md": Expected front matter'));
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
    }
  });

  it("shows help and rejects unknown options", async () => {
    expect(await projectCommand(["lessons", "--help"], { stdout, stderr })).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("project lessons [folder] [--json]"));
    expect(await projectCommand(["lessons", "--promote"], { stdout, stderr })).toBe(2);
    expect(stderr).toHaveBeenCalled();
  });
});
