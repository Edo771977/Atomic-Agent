import * as configModule from "../config/index.js";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { resolveProjectConstraint } from "../config/project-constraint-match.js";
import { stateDirProjectRecords } from "../session/project-decisions.js";
import { createSessionProjectStore, readProjectRef } from "../session/session-project-store.js";
import { SessionStore } from "../session/session-store.js";
import { createEmptySessionState } from "../session/session-state.js";
import { buildPrompt } from "../prompt/build-prompt.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { createPlanReview } from "../tools/fusion/plan-reviewer.js";
import { PLAN_REVIEW_DIMENSIONS } from "../tools/fusion/plan-review-record.js";
import { parseTeamMember } from "../llm/run-mode/fusion-team.js";
import { workerProjectLessonBlock } from "../tools/fusion/worker-project-lessons.js";
import { projectCommand } from "./projects-command.js";

const fingerprint = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);
const approval = (dir: string, id: string) => id + "@" + fingerprint(join(dir, id + ".md"));

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
        "status: proposed", "from: milestone m1, run r1", "always: false", "---", "## Decided", "## Tried and ruled out", "## Watch out",
      ].join(EOL));
    }
    expect(resolveProjectConstraint(getConfig(), folder)?.allowedProviders).toEqual([]);
    const configBefore = readFileSync(configFile, "utf8");
    const before = readdirSync(state, { recursive: true }).sort();
    writeFileSync(join(folder, ".atomic", "project", "lessons", "broken.md"), "broken");
    expect(await projectCommand(["lessons", folder, "--json"], { stdout, stderr })).toBe(0);
    expect(JSON.parse(stdout.mock.calls[0]![0])).toEqual({
      lessons: [{
        id: "private-lesson", fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/), title: "Project decision", declaredStatus: "proposed", source: "person", from: "milestone m1, run r1",
        approvedByPerson: false, effectiveStatus: "proposed", personState: null, stale: false, always: false, touches: ["src/file.ts"],
      }],
      problems: [{ file: "broken.md", reason: expect.stringMatching(/front matter/i) }],
    });
    expect(stderr).not.toHaveBeenCalled();
    expect(readdirSync(state, { recursive: true }).sort()).toEqual(before);
    expect(readFileSync(configFile, "utf8")).toBe(configBefore);
  });

  it.each([["\u{E0061}", "E0061"], ["\u202E", "202E"]])("skips invisible text in CLI listings (%s)", async (character, code) => {
    const dir = join(root, ".atomic", "project", "lessons");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "lesson.md"), [
      "---", "id: lesson", "title: A lesson", "source: person", "touches: []", "status: active", "always: true",
      "---", "## Decided", "Inert " + character + " text", "## Tried and ruled out", "## Watch out",
    ].join(EOL));
    expect(await projectCommand(["lessons", root, "--json"], { stdout, stderr, stateDir: () => join(root, "state") })).toBe(0);
    expect(JSON.parse(stdout.mock.lastCall![0])).toMatchObject({
      lessons: [], problems: [{ file: "lesson.md", reason: expect.stringContaining("U+" + code) }],
    });
  });

  it("binds approval to the lesson contents and reopens stale choices", async () => {
    const folder = join(root, "project");
    const stateDir = join(root, "state");
    const records = stateDirProjectRecords(stateDir);
    const store = createSessionProjectStore({ stateDir, records });
    mkdirSync(folder);
    const session = createEmptySessionState({ id: "chat", workingDir: folder });
    const saved = store.commit(session, { gate: { kind: "none" }, milestones: [] });
    if (!saved.ok) throw new Error(saved.problem.message);
    const dir = join(folder, ".atomic", "project", "lessons");
    mkdirSync(dir);
    const file = join(dir, "lesson.md");
    const original = [
      "---", "id: lesson", "title: A lesson", "source: person", "touches: [src/file.ts]",
      "status: active", "always: true", "---", "## Decided", "Use Y", "## Tried and ruled out", "X", "## Watch out",
    ].join(EOL);
    writeFileSync(file, original);
    const io = { stdout, stderr, stateDir: () => stateDir };
    const sessions = new SessionStore({ dbFile: join(stateDir, "sessions.sqlite") });
    try {
      sessions.save({ ...saved.session, workingDir: join(folder, "worktree") });
      expect(sessions.beginTurn(session.id)).toBe(true);
      expect(await projectCommand(["lessons", folder, "--approve", "lesson"], { ...io, sessionStore: sessions })).toBe(1);
      expect(records.read(folder)).toMatchObject({ record: expect.not.objectContaining({ lessonCalls: expect.anything() }) });
      sessions.releaseTurn(session.id, { status: "completed" });
      expect(await projectCommand(["lessons", folder, "--approve", "lesson"], io)).toBe(1);
      expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining(approval(dir, "lesson")));
      const seen = approval(dir, "lesson");
      writeFileSync(file, original + EOL);
      expect(await projectCommand(["lessons", folder, "--approve", seen], io)).toBe(1);
      expect(stderr).toHaveBeenLastCalledWith(expect.stringMatching(/lesson has changed.*read/i));
      writeFileSync(file, original);
      const upperCase = "lesson@" + seen.split("@")[1]!.toUpperCase();
      expect(await projectCommand(["lessons", folder, "--approve", upperCase], { ...io, sessionStore: sessions })).toBe(0);
    } finally {
      sessions.close();
    }
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(records.read(folder)).toMatchObject({
      record: { lessonCalls: { lesson: { state: "approved", hash: expect.stringMatching(/^[a-f0-9]{64}$/) } } },
    });
    const row = async () => {
      stdout.mockClear();
      expect(await projectCommand(["lessons", folder, "--json"], io)).toBe(0);
      return JSON.parse(stdout.mock.lastCall![0]).lessons[0];
    };
    expect(await row()).toMatchObject({ effectiveStatus: "active", approvedByPerson: true });
    writeFileSync(file, original.replace("Use Y", "Use Z"));
    expect(await row()).toMatchObject({ effectiveStatus: "unapproved", stale: true, approvedByPerson: false });
    expect(await projectCommand(["lessons", folder, "--retire", "lesson"], io)).toBe(0);
    expect(await row()).toMatchObject({ effectiveStatus: "retired", approvedByPerson: false });
    expect(await projectCommand(["lessons", folder, "--reopen", "lesson"], io)).toBe(0);
    expect(await row()).toMatchObject({ effectiveStatus: "unapproved", stale: false });
    const reopened = records.read(folder);
    stdout.mockClear();
    expect(await projectCommand(["lessons", folder, "--reopen", "lesson"], io)).toBe(0);
    expect(stdout.mock.calls[0]?.[0]).toContain("No choice to reopen for lesson");
    expect(records.read(folder)).toEqual(reopened);
    const recordsDir = join(stateDir, "project-decisions");
    writeFileSync(join(recordsDir, readdirSync(recordsDir).find((name) => name.endsWith(".json"))!), "{");
    expect(await row()).toMatchObject({ id: "lesson", approvedByPerson: false });
    expect(stderr).toHaveBeenLastCalledWith(expect.stringMatching(/warning.*record/i));
  });

  it("projects only current active lessons into each prompt and honors folder provider constraints", async () => {
    const folder = join(root, "project");
    const stateDir = join(root, "state");
    const dir = join(folder, ".atomic", "project", "lessons");
    mkdirSync(stateDir);
    mkdirSync(dir, { recursive: true });
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", stateDir);
    resetConfigCache();
    const records = stateDirProjectRecords(stateDir);
    const store = createSessionProjectStore({ stateDir, records });
    const saved = store.commit(createEmptySessionState({ id: "chat", workingDir: folder }), {
      gate: { kind: "none" }, milestones: [],
      brief: { version: 1, status: "approved", what: "Build", users: "Team", how: "Code", successCriteria: [], draftedAfterUntrusted: false },
    });
    if (!saved.ok) throw new Error(saved.problem.message);
    const source = readProjectRef(saved.session)!;
    const writeLesson = (id: string, status = "active", body = id) => writeFileSync(join(dir, id + ".md"), [
      "---", "id: " + id, "title: Storage", "source: person", "touches: [src/main.ts]",
      "status: " + status, "always: true", "---", "## Decided", "## Tried and ruled out", body, "## Watch out",
    ].join(EOL));
    for (const id of ["private-active", "private-stale", "private-retired", "private-proposed", "private-unapproved"]) {
      writeLesson(id, id === "private-proposed" ? "proposed" : "active");
    }
    for (const [action, id] of [["approve", "private-active"], ["approve", "private-stale"], ["retire", "private-retired"]]) {
      expect(await projectCommand(["lessons", folder, "--" + action, action === "approve" ? approval(dir, id!) : id!], { stdout, stderr, stateDir: () => stateDir })).toBe(0);
    }
    for (const status of ["proposed", "retired"]) {
      writeLesson("private-proposed", status);
      expect(await projectCommand(["lessons", folder, "--approve", approval(dir, "private-proposed")], { stdout, stderr, stateDir: () => stateDir })).toBe(1);
      expect(stderr).toHaveBeenLastCalledWith(expect.stringContaining("status: " + status));
    }
    writeLesson("private-proposed", "proposed");
    writeLesson("private-stale", "active", "changed");

    const director = (mode: "local" | "cloud", providerId: string, session = saved.session) => {
      const input: BuildPromptInput = {
        session, toolDescriptors: [], skillCatalog: [],
        modelMode: { mode, providerId, source: "provider", modelId: "test" },
        capabilities: { platform: process.platform, arch: process.arch, browserChannel: "chrome", workingDir: folder, hasClipboard: false, hasWmctrl: false, hasNotifications: false },
      };
      return buildPrompt(input);
    };
    const worker = (providerId: string, files = ["src/main.ts"]) => workerProjectLessonBlock(
      source, providerId, { id: "t1", title: "Work", instructions: "Work", files }, undefined, folder,
    );
    const cited = workerProjectLessonBlock(
      source, "cloud", { id: "t1", title: "Work", instructions: "Work", files: ["src/other.ts"] },
      undefined, folder, ["private-active"],
    );
    expect(cited).toMatch(/EXTERNAL CONTENT[\s\S]*"id":"private-active"[\s\S]*"binding":true/);
    const reviewer = async (providerId: string) => {
      const complete = vi.fn(async ({ prompt: _prompt }: { prompt: string }) => ({ content: JSON.stringify({
        results: PLAN_REVIEW_DIMENSIONS.map((dimension) => ({ dimension, verdict: "pass", detail: "OK", taskIds: [] })),
      }) }));
      const review = createPlanReview({
        team: () => ({ reviewers: [parseTeamMember(providerId + ":test")!] }),
        allows: () => true, restricted: () => false, reachable: () => true, pinsModel: () => false,
        complete, pricing: () => undefined,
      });
      const result = await review({
        lessonSource: source, signal: undefined, sessionId: "chat",
        input: { brief: { what: "Build", users: "Team", how: "Code" }, rows: [], criteria: [], decisions: [], milestones: [], planChecks: [] },
      });
      expect(result).toMatchObject({ reviewerProviderId: providerId });
      return complete.mock.calls[0]![0].prompt;
    };

    const cloud = director("cloud", "cloud");
    expect(cloud.stablePrefix).not.toContain("private-active");
    expect(JSON.stringify(cloud.cloudContext)).not.toContain("private-active");
    for (const prompt of [cloud.messages.tail, director("local", "local-llama").tail, await reviewer("cloud"), worker("cloud")]) {
      expect(prompt).toMatch(/EXTERNAL CONTENT[\s\S]*private-active/);
      expect(prompt).not.toMatch(/private-(stale|retired|proposed|unapproved)/);
    }
    expect(worker("cloud", ["src/other.ts"])).toBeNull();

    writeFileSync(join(stateDir, "config.json"), JSON.stringify({
      llm: {
        activeTextProvider: "local-llama",
        providers: [{ id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" }],
      },
      projects: { constraints: { [folder]: { allowedProviders: ["local-llama"] } } },
    }));
    resetConfigCache();
    expect(director("local", "local-llama").tail).toContain("private-active");
    expect(director("cloud", "cloud", { ...saved.session, cloudContext: cloud.cloudContext! }).text).not.toContain("private-active");
    const restrictedReview = await reviewer("cloud");
    expect(restrictedReview).not.toContain("private-active");
    expect(restrictedReview).toContain("Active lessons were not supplied by the folder policy.");
    expect(worker("cloud")).toBeNull();
  });

  it("lists constructor with no stale inherited choice", async () => {
    const dir = join(root, ".atomic", "project", "lessons");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "constructor.md"), "---\nid: constructor\ntitle: Test\nsource: person\ntouches: []\nstatus: active\nalways: false\n---\n## Decided\n## Tried and ruled out\n## Watch out\n");
    expect(await projectCommand(["lessons", root, "--json"], { stdout, stderr, stateDir: () => join(root, "state") })).toBe(0);
    expect(JSON.parse(stdout.mock.lastCall![0]).lessons[0]).toMatchObject({ stale: false, personState: null });
  });

  it("reads lesson choices from the configured state directory", async () => {
    const config = vi.spyOn(configModule, "getConfig");
    try {
      await projectCommand(["lessons", root], { stdout, stderr });
      expect(config).toHaveBeenCalled();
    } finally {
      config.mockRestore();
    }
  });

  it("cannot persist approvals for a project opened only in incognito", async () => {
    const folder = join(root, "private");
    const stateDir = join(root, "state");
    const records = stateDirProjectRecords(stateDir);
    const store = createSessionProjectStore({ stateDir, records });
    const dir = join(folder, ".atomic", "project", "lessons");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "secret.md"), [
      "---", "id: secret", "title: Incognito lesson", "source: person", "touches: []",
      "status: active", "always: false", "---", "## Decided", "## Tried and ruled out", "## Watch out",
    ].join(EOL));
    const session = createEmptySessionState({ id: "private-chat", workingDir: folder, incognito: { since: Date.now(), owner: "test" } });
    expect(store.commit(session, { gate: { kind: "none" }, milestones: [] }).ok).toBe(true);
    expect(await projectCommand(["lessons", folder, "--approve", "secret"], { stdout, stderr, stateDir: () => stateDir })).toBe(1);
    expect(records.read(folder)).toEqual({ ok: true, record: null });
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
