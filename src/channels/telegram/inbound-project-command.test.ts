import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { projectFolderKey, projectRecordsDir, stateDirProjectRecords } from "../../session/project-decisions.js";
import { readProjectLessons } from "../../session/project-lessons.js";
import type { ProjectBacklogDecision } from "../../session/project-backlog.js";
import { fixtureProjectGateView } from "../../session/project-gate-view-fixtures.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";
import type { ProjectDecision } from "../../session/session-project.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createAttachmentInbox } from "../attachments/inbox.js";
import { CHANNEL_RESTRICTED_NOTICE } from "../channel-egress.js";
import { addressedText, handleInboundText, type InboundContext } from "./inbound-handler.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";

/** Issue #39: `/plan` and the after-turn gate notice, through `handleInboundText`. */
const OWNER = 42;
const CHAT = 100;

describe("Telegram project gate", () => {
  let dir: string;
  let view: ProjectGateView | undefined;
  let messages: string[];
  let decisions: ProjectDecision[];
  let backlogDecisions: Array<{ sessionId: string; decision: ProjectBacklogDecision }>;
  let sent: string[];
  let withholdProject: boolean;
  let projectSession: SessionState | undefined;
  let liveProjectTurn: string | null;
  let ctx: InboundContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-project-"));
    view = undefined;
    messages = [];
    decisions = [];
    backlogDecisions = [];
    sent = [];
    withholdProject = false;
    projectSession = undefined;
    liveProjectTurn = null;
    const sessions: SessionState[] = [];
    const runtime = {
      createSession: () => {
        const s = createEmptySessionState({ id: `s-${sessions.length + 1}`, workingDir: "/tmp/test" });
        sessions.push(s);
        return s;
      },
      config: { paths: { stateDir: join(dir, "state") } },
      sessionStore: {
        load: (id: string) => projectSession?.id === id ? projectSession : sessions.find((s) => s.id === id) ?? null,
        liveProjectTurn: () => liveProjectTurn,
      },
      turnController: { isBusy: () => false },
      runTurn: async (session: SessionState, text: string, opts?: { eventHook?: (e: AgentLoopEvent) => void }) => {
        messages.push(text);
        if (text === "propose a lesson") {
          opts?.eventHook?.({ type: "llm_event", event: {
            type: "tool_call_executed", batchIndex: 0, batchSize: 1,
            result: { tool: "project.lesson.propose", status: "ok", details: {}, truncated: false,
              summary: "Saved director-authored lesson proposal storage (declared origin: correction, milestone m1, run r1)." },
          } });
        }
        opts?.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "drafted" } });
        // The first turn drafts a plan and opens its gate.
        if (messages.length === 1) view = fixtureProjectGateView({ kind: "plan" });
        return { session, reason: "reply" as const, stepCount: 1 };
      },
      projectState: () => view ?? null,
      channelSendRefusal: () => withholdProject ? "restricted fixture" : null,
      projectDecision: (_id: string, d: ProjectDecision) => {
        decisions.push(d);
        view = fixtureProjectGateView({ kind: "none" }, { version: 4, expectation: { kind: "run_milestone", id: "m1" } });
        return { ok: true as const, project: { milestones: [], gate: { kind: "none" as const } }, view };
      },
      projectBacklogDecision: (sessionId: string, decision: ProjectBacklogDecision) => {
        backlogDecisions.push({ sessionId, decision });
        return { ok: true as const, project: { milestones: [], gate: { kind: "none" as const } }, view: view! };
      },
    } as unknown as AgentRuntime;
    ctx = {
      runtime,
      api: {
        sendMessage: vi.fn(async (_chat: number, text: string) => { sent.push(text); return { message_id: sent.length }; }),
        sendChatAction: vi.fn(async () => undefined),
        editMessageText: vi.fn(async () => true),
        deleteMessage: vi.fn(async () => true),
      },
      sessionPointer: new TelegramSessionPointer(join(dir, "telegram-session.json")),
      logger: new StructuredLogger({ level: "warn", sinks: [] }),
      ownerUserId: OWNER,
      inflight: new Map(),
      inbox: createAttachmentInbox({ dir: join(dir, "inbox") }),
      mediaGroups: new Map(),
      scheduleKeepalive: () => () => undefined,
      progressIndicator: false,
    } as InboundContext;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const say = (text: string, user = OWNER, chat = CHAT) =>
    handleInboundText({ from: { id: user }, chat: { id: chat, type: "private" }, text, message_id: 1 }, ctx);

  it("identifies a saved proposal and its director-declared origin in Telegram", async () => {
    await say("propose a lesson");
    expect(sent).toContain("Saved director-authored lesson proposal storage (declared origin: correction, milestone m1, run r1).");
  });

  it("tells the owner a gate waits after the turn, and /plan approve continues the work", async () => {
    await say("build a puzzle game");
    expect(sent.at(-2)).toBe("drafted");
    expect(sent.at(-1)).toContain("The project plan waits for your approval");
    expect(sent.at(-1)).toContain("/plan approve 3");

    await say("/plan approve 3");
    expect(decisions).toEqual([{ gate: { kind: "plan" }, version: 3, verdict: "approve" }]);
    expect(sent).toContain("Approved the plan (version 3): 2 tasks, $0.12 (+1 unpriced), ~1m30s.");
    expect(messages).toEqual(["build a puzzle game", 'I approved. Continue with milestone "Base".']);
  });

  it("limits decision previews and edits to the owner and the session of this chat", async () => {
    await say("build a puzzle game");
    view = fixtureProjectGateView({ kind: "plan" }, {
      decisions: [{ id: "d1", text: "Use SQLite", status: "active", citedBy: [] }],
    });
    const count = sent.length;
    await say("/defer d1", OWNER + 1);
    await say("/defer d1 3", OWNER + 1);
    expect(sent).toHaveLength(count);
    await say("/defer d1", OWNER, CHAT + 1);
    await say("/defer d1 3", OWNER, CHAT + 1);
    expect(sent.slice(count)).toEqual(["This chat has no project.", "This chat has no project."]);
    expect(decisions).toEqual([]);

    await say("/defer d1");
    expect(sent.at(-1)).toContain("/defer d1 3");
    expect(decisions).toEqual([]);
    await say("/defer d1 3");
    expect(decisions).toEqual([{ gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { decisionStatus: { d1: "deferred" } } }]);
    expect(messages).toEqual(["build a puzzle game"]);
  });

  it("withholds decision details and edits when the session cannot send to Telegram", async () => {
    await say("build a puzzle game");
    view = fixtureProjectGateView({ kind: "plan" }, {
      decisions: [{ id: "d1", text: "Keep test data private", status: "active", citedBy: [] }],
    });
    withholdProject = true;
    const count = sent.length;
    await say("/defer d1");
    await say("/defer d1 3");
    expect(sent.slice(count)).toEqual([CHANNEL_RESTRICTED_NOTICE, CHANNEL_RESTRICTED_NOTICE]);
    expect(decisions).toEqual([]);
  });

  function backlogView(gate: ProjectGateView["gate"]) {
    return fixtureProjectGateView(gate, {
      backlog: {
        open: 1, stale: [], promoted: [],
        seeds: [{ id: "b1", title: "<b>PDF</b> & export", condition: "When reports exist" }],
        items: [{ id: "b1", title: "<b>PDF</b> & export", condition: "When reports exist", createdAt: 1, source: "director", state: "open" }],
      },
    });
  }

  it("handles a backlog command between gates as plain text in the paired owner's chat", async () => {
    await say("build a puzzle game");
    view = backlogView({ kind: "none" });
    const count = sent.length;
    await say("/backlog", OWNER + 1);
    await say("/promote b1", OWNER + 1);
    expect(sent).toHaveLength(count);
    await say("/backlog", OWNER, CHAT + 1);
    expect(sent.at(-1)).toMatch(/no project record/);
    await say("/backlog");
    expect(sent.at(-1)).toContain("<b>PDF</b> & export");
    expect(vi.mocked(ctx.api.sendMessage).mock.lastCall?.[2]?.parse_mode).toBeUndefined();
    await say("/promote b1");
    const code = sent.at(-1)?.match(/\/promote b1 ([0-9a-f]{16})/)?.[1];
    expect(code).toBeDefined();
    expect(backlogDecisions).toEqual([]);
    await say(`/promote b1 ${code}`, OWNER + 1);
    await say(`/promote b1 ${code}`, OWNER, CHAT + 1);
    withholdProject = true;
    await say(`/promote b1 ${code}`);
    expect(sent.at(-1)).toBe(CHANNEL_RESTRICTED_NOTICE);
    expect(backlogDecisions).toEqual([]);
    withholdProject = false;
    await say(`/promote b1 ${code}`);
    expect(backlogDecisions).toEqual([{ sessionId: "s-1", decision: { id: "b1", state: "promoted", expectedFingerprint: expect.any(String) } }]);
    expect(messages).toEqual(["build a puzzle game"]);
  });

  it.each([["/defer", "deferred", false], ["/activate", "active", true]] as const)(
    "previews and confirms %s for the displayed plan and backlog item", async (command, status, deferred) => {
      await say("build a puzzle game");
      const base = backlogView({ kind: "plan" });
      const item = { ...base.backlog!.items[0]!, state: "promoted" as const };
      const promoted = { id: item.id, title: item.title, citedBy: ["t1"], ...(deferred ? { deferred: true as const } : {}) };
      const shown = { ...base, backlog: { ...base.backlog!, items: [item], promoted: [promoted] } };

      view = { ...shown, gate: { kind: "none" } };
      await say(`${command} b1`);
      expect(sent.at(-1)).toMatch(/plan.*approval/i);
      view = { ...shown, backlog: { ...shown.backlog, promoted: [{ id: item.id, title: item.title }] } };
      await say(`${command} b1`);
      expect(sent.at(-1)).toMatch(/promoted.*plan/i);
      view = shown;
      await say(`${command} b1`);
      const preview = sent.at(-1)!;
      expect(preview).toContain(item.title);
      const code = preview.match(/b1 ([0-9a-f]{16})/)?.[1];
      expect(code).toBeDefined();
      expect(decisions).toEqual([]);

      view = { ...shown, version: 4 };
      await say(`${command} b1 ${code}`);
      expect(sent.at(-1)).toMatch(/preview.*again/i);
      view = { ...shown, backlog: { ...shown.backlog, items: [{ ...item, title: "Changed outside" }] } };
      await say(`${command} b1 ${code}`);
      expect(sent.at(-1)).toMatch(/preview.*again/i);
      view = shown;
      await say(`${command} b1 ${code}`, OWNER + 1);
      expect(decisions).toEqual([]);
      await say(`${command} b1 ${code}`);
      expect(decisions).toEqual([{ gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { backlogStatus: { b1: status } } }]);
      expect(messages).toEqual(["build a puzzle game"]);
    },
  );

  function writeLesson(status = "active", decided = "<b>Keep SQLite</b>") {
    const folder = join(dir, ".atomic", "project", "lessons");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "storage.md"), [
      "---", "id: storage", "title: Local storage", "source: person",
      "status: " + status, "always: true", "touches: [src/storage]", "---",
      "## Decided", decided, "## Tried and ruled out", "Remote storage",
      "## Watch out", "Check migrations",
    ].join("\n"));
    writeFileSync(join(folder, "invalid.md"), "invalid lesson");
  }

  async function openLessons(status?: string, incognito = false) {
    await say("build a puzzle game");
    const records = stateDirProjectRecords(join(dir, "state"));
    expect(records.write(dir, "project1", 0, { gate: { kind: "none" }, milestones: [] }).ok).toBe(true);
    const session = createEmptySessionState({ id: "s-1", workingDir: dir });
    projectSession = {
      ...session,
      projectRef: { folder: dir, id: "project1", revision: 1, decisionSeq: 1 },
      ...(incognito ? { incognito: { owner: "fixture", since: 1 } } : {}),
    };
    writeLesson(status);
    const record = () => {
      const read = records.read(dir);
      if (!read.ok || read.record === null) throw new Error("Missing fixture record");
      return read.record;
    };
    return record;
  }

  async function previewLesson(command: string) {
    const start = sent.length;
    await say(command + " storage");
    const preview = sent.slice(start).join("\n");
    const code = preview.match(/storage ([0-9a-f]{16})/)?.[1];
    expect(code).toBeDefined();
    return { preview, confirm: command + " storage " + code };
  }

  it("recognizes a lesson command addressed to the bot in a group", () => {
    const update = { from: { id: OWNER }, chat: { id: CHAT, type: "group" }, text: "/lesson_approve@lesson_bot storage", message_id: 1 };
    expect(addressedText(update, { id: 1, username: "lesson_bot" })).toEqual({ text: "/lesson_approve storage" });
  });

  it("lists lessons and skipped files without changing the record", async () => {
    const record = await openLessons();
    const before = record();
    await say("/lessons");
    expect(sent.at(-1)).toMatch(/storage.*Local storage.*active.*unapproved.*always: true.*src\/storage/i);
    expect(sent.at(-1)).toMatch(/Skipped.*invalid\.md.+/i);
    expect(record()).toEqual(before);
  });

  it("previews the current fingerprint and lets only the paired owner approve it", async () => {
    const record = await openLessons();
    const hash = readProjectLessons(dir).lessons[0]!.hash;
    const { preview, confirm } = await previewLesson("/lesson_approve");
    expect(preview).toContain(hash.slice(0, 12));
    for (const part of ["Local storage", "always: true", "src/storage", "<b>Keep SQLite</b>", "Remote storage", "Check migrations"]) {
      expect(preview).toContain(part);
    }
    expect(vi.mocked(ctx.api.sendMessage).mock.lastCall?.[2]?.parse_mode).toBeUndefined();
    await say(confirm, OWNER + 1);
    await say(confirm, OWNER, CHAT + 1);
    withholdProject = true;
    await say(confirm);
    expect(sent.at(-1)).toBe(CHANNEL_RESTRICTED_NOTICE);
    expect(record().lessonCalls).toBeUndefined();
    withholdProject = false;
    await say(confirm);
    expect(record().lessonCalls?.storage).toEqual({ state: "approved", hash, always: true });
    await say("/lessons");
    expect(sent.at(-1)).toMatch(/declared: active.*effective: approved/i);
  });

  it("shows all short lines that can reach the prompts before approving", async () => {
    await openLessons();
    const lines = Array.from({ length: 12 }, (_, index) => "Review line " + (index + 1));
    writeLesson("active", lines.join("\n"));
    const { preview } = await previewLesson("/lesson_approve");
    for (const line of lines) expect(preview).toContain(line);
  });

  it("refuses approval when the full section cannot be shown", async () => {
    const record = await openLessons();
    writeLesson("active", "a".repeat(601));
    await say("/lesson_approve storage");
    expect(sent.at(-1)).toMatch(/too long.*file.*CLI/i);
    expect(sent.at(-1)).not.toMatch(/storage [0-9a-f]{16}/);
    expect(record().lessonCalls).toBeUndefined();
  });

  it("withholds approval confirmation if a preview chunk fails to send", async () => {
    await openLessons();
    writeLesson("active", "Review text");
    const file = join(dir, ".atomic", "project", "lessons", "storage.md");
    const longPath = "src/" + "x".repeat(250);
    const paths = Array.from({ length: 20 }, (_, i) => longPath + i).join(", ");
    writeFileSync(file, readFileSync(file, "utf8").replace("src/storage", paths));
    vi.mocked(ctx.api.sendMessage).mockRejectedValueOnce(new Error("delivery failed"));
    const start = sent.length;
    await say("/lesson_approve storage");
    expect(sent.slice(start).join("\n")).not.toMatch(/storage [0-9a-f]{16}/);
  });

  it("routes Telegram-compatible lesson commands and advertises them in help", async () => {
    await openLessons();
    await say("/help");
    expect(sent.join("\n")).toContain("/lesson_approve");
    const { preview } = await previewLesson("/lesson_approve");
    expect(preview).toContain("reply /lesson_approve storage");
  });

  it("lists files on a damaged record without disclosing its path or allowing writes", async () => {
    await openLessons();
    const path = join(projectRecordsDir(join(dir, "state")), projectFolderKey(dir) + ".json");
    writeFileSync(path, "{bad json");
    projectSession = { ...projectSession!, projectProblem: "Cannot open " + path };
    await say("/lessons");
    expect(sent.at(-1)).toMatch(/warning.*record/i);
    expect(sent.at(-1)).toContain("Local storage");
    expect(sent.at(-1)).toContain("invalid.md");
    expect(sent.at(-1)).not.toContain(path);
    await say("/lesson_retire storage");
    expect(sent.at(-1)).toMatch(/record.*unavailable/i);
    expect(sent.at(-1)).not.toContain(path);
    expect(readFileSync(path, "utf8")).toBe("{bad json");
  });

  it("does not disclose the record path if the record breaks during confirmation", async () => {
    await openLessons();
    const { confirm } = await previewLesson("/lesson_approve");
    const path = join(projectRecordsDir(join(dir, "state")), projectFolderKey(dir) + ".json");
    vi.spyOn(ctx.runtime.sessionStore, "liveProjectTurn").mockImplementationOnce(() => {
      writeFileSync(path, "{bad json");
      return null;
    });
    await say(confirm);
    expect(sent.at(-1)).toMatch(/lesson unchanged/i);
    expect(sent.at(-1)).not.toContain(path);
    expect(readFileSync(path, "utf8")).toBe("{bad json");
  });

  it("bounds lesson listing and reports omitted touches and lessons", async () => {
    await openLessons();
    const folder = join(dir, ".atomic", "project", "lessons");
    const original = readFileSync(join(folder, "storage.md"), "utf8");
    const paths = ["first", "second", "third", "fourth", "fifth"].map((part) => "src/" + part + "/" + "x".repeat(750));
    for (let i = 0; i < 30; i++) {
      const id = "lesson-" + String(i).padStart(2, "0");
      writeFileSync(join(folder, id + ".md"), original.replace("id: storage", "id: " + id).replace("src/storage", paths.join(", ")));
    }
    const start = sent.length;
    await say("/lessons");
    const chunks = sent.slice(start);
    const list = chunks.join("\n");
    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(list).toMatch(/src\/first.*src\/second.*src\/third.*\+2/);
    expect(list).not.toContain("src/fourth");
    expect(list).toMatch(/\+[1-9]\d* lessons: use the CLI/i);
  });

  it("shows only the short previous fingerprint when the lesson file is missing", async () => {
    await openLessons();
    const hash = readProjectLessons(dir).lessons[0]!.hash;
    await say((await previewLesson("/lesson_retire")).confirm);
    rmSync(join(dir, ".atomic", "project", "lessons", "storage.md"));
    const { preview } = await previewLesson("/lesson_reopen");
    expect(preview).toContain("Previous fingerprint: " + hash.slice(0, 12) + ".");
    expect(preview).not.toContain(hash);
  });

  it("refuses a changed file and a proposed lesson", async () => {
    const record = await openLessons();
    const { confirm } = await previewLesson("/lesson_approve");
    writeLesson("active", "Changed");
    await say(confirm);
    expect(sent.at(-1)).toMatch(/lesson has changed.*read it again/i);
    writeLesson("proposed");
    await say("/lesson_approve storage");
    expect(sent.at(-1)).toMatch(/cannot approve.*proposed/i);
    expect(record().lessonCalls).toBeUndefined();
  });

  it("retires the current file and reopens the protected choice", async () => {
    const record = await openLessons();
    await say((await previewLesson("/lesson_retire")).confirm);
    expect(record().lessonCalls?.storage?.state).toBe("retired");
    writeLesson("active", "Changed after retirement");
    await say("/lessons");
    expect(sent.at(-1)).toMatch(/stale/i);
    await say((await previewLesson("/lesson_reopen")).confirm);
    expect(record().lessonCalls?.storage).toBeUndefined();
  });

  it.each([["/lesson_defer", "deferred", false], ["/lesson_activate", "active", true]] as const)(
    "confirms %s only against the displayed plan version", async (command, status, deferred) => {
      await openLessons();
      await say((await previewLesson("/lesson_approve")).confirm);
      const base = fixtureProjectGateView({ kind: "plan" }, {
        lessonCoverage: [{ id: "storage", title: "Local storage", deferred, citedBy: [], missingFrom: ["t1"] }],
      });
      view = { ...base, gate: { kind: "none" } };
      await say(command + " storage");
      expect(sent.at(-1)).toMatch(/plan.*approval/i);
      view = base;
      await say("/plan");
      expect(sent.at(-1)).toContain("/lesson_defer <id> or /lesson_activate <id>");
      const { preview, confirm } = await previewLesson(command);
      expect(preview).toContain("Plan v3");
      view = { ...base, version: 4 };
      await say(confirm);
      expect(sent.at(-1)).toMatch(/preview.*again/i);
      expect(decisions).toEqual([]);
      view = base;
      await say(confirm);
      expect(decisions).toEqual([{ gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { lessonStatus: { storage: status } } }]);
    },
  );

  it("refuses confirmation while a turn is live on the same project", async () => {
    const record = await openLessons();
    const { confirm } = await previewLesson("/lesson_approve");
    ctx.inflight.set(String(CHAT), new AbortController());
    await say(confirm);
    expect(sent.at(-1)).toMatch(/wait for the current turn to finish/i);
    ctx.inflight.clear();
    liveProjectTurn = "another-chat";
    await say(confirm);
    expect(sent.at(-1)).toMatch(/wait for the current turn to finish/i);
    expect(record().lessonCalls).toBeUndefined();
  });

  it("refuses lesson commands in incognito", async () => {
    const record = await openLessons("active", true);
    for (const command of ["/lessons", "/lesson_approve storage", "/lesson_defer storage"]) {
      await say(command);
      expect(sent.at(-1)).toMatch(/unavailable in incognito/i);
    }
    expect(record().lessonCalls).toBeUndefined();
  });

  it("does not promote a seed when showing or approving the plan", async () => {
    await say("build a puzzle game");
    view = backlogView({ kind: "plan" });
    await say("/plan");
    await say("/plan approve 3");
    expect(decisions).toEqual([{ gate: { kind: "plan" }, version: 3, verdict: "approve" }]);
    expect(backlogDecisions).toEqual([]);
  });
});
