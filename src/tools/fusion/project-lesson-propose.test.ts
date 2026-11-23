import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wouldRefuse } from "../../agent/policies/fusion-orchestrator-mode.js";
import { expect, it, vi } from "vitest";
import { approvedProjectLessons, readProjectLessons } from "../../session/project-lessons.js";
import { sameLessonProjectFolder, buildProjectLessonTool } from "./project-lesson-propose.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, linkSync: vi.fn(fs.linkSync) };
});

it("uses workspace write approval and creates only a new, inactive proposal", async () => {
  const folder = mkdtempSync(join(tmpdir(), "atomic-proposal-"));
  try {
    const request = vi.fn().mockResolvedValueOnce({ approved: false, reason: "denied" }).mockResolvedValue({ approved: true });
    const tool = buildProjectLessonTool({ approvalRequired: true, approvals: { request, fanoutScopes: { allows: () => false } } as never });
    expect(wouldRefuse(tool.name, { registry: { has: () => true, get: () => tool } })).toBe(false);
    const ctx = { workingDir: folder, sessionId: "s1", projectRef: { folder, id: "p" }, project: { milestones: [{ id: "m1", runIds: ["r1"], corrections: [{ note: "Use existing dependencies.", at: 1 }] }] } } as never;
    const args = { id: "no-deps", title: "No new dependencies", source: "correction",
      from: "milestone m1, run r1", touches: ["package.json"], always: false,
      decided: "Use the existing dependencies.", triedAndRuledOut: "", watchOut: "" };
    expect((await tool.run(args, { ...(ctx as object), projectRef: undefined } as never)).status).toBe("error");
    await expect(tool.run(args, ctx)).rejects.toThrow("denied");
    expect(readProjectLessons(folder).lessons).toEqual([]);
    vi.mocked(linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("hard links unsupported"), { code: "EOPNOTSUPP" });
    });
    const result = await tool.run(args, ctx);
    expect(result.status).toBe("ok");
    expect(request.mock.calls[0]?.[0]).toMatchObject({ category: "trust_config" });
    const [lesson] = readProjectLessons(folder).lessons;
    expect(lesson).toMatchObject({ declaredStatus: "proposed", source: "correction", from: args.from });
    expect(approvedProjectLessons(folder, { "no-deps": { state: "approved", hash: lesson!.hash, at: 1 } } as never)).toEqual([]);
    const path = join(folder, ".atomic", "project", "lessons", "no-deps.md");
    const original = readFileSync(path, "utf8");
    expect((await tool.run({ ...args, decided: "replacement" }, ctx)).status).toBe("error");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect((await tool.run({ ...args, id: "other", status: "active" }, ctx)).status).toBe("error");
    const dir = join(folder, ".atomic", "project", "lessons");
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(dir, `existing-${i}.md`), original.replace("id: no-deps", `id: existing-${i}`));
    }
    const full = await tool.run({ ...args, id: "one-too-many" }, ctx);
    expect(full.status).toBe("error");
    expect(full.summary).toMatch(/proposal limit/i);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

it("compares case according to the host's workspace platform", () => {
  expect(sameLessonProjectFolder("/Projects/Example", "/projects/example", "win32")).toBe(true);
  expect(sameLessonProjectFolder("/Projects/Example", "/projects/example", "darwin")).toBe(true);
  expect(sameLessonProjectFolder("/Projects/Example", "/projects/example", "linux")).toBe(false);
});
