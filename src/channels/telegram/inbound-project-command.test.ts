import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { fixtureProjectGateView } from "../../session/project-gate-view-fixtures.js";
import type { ProjectGateView } from "../../session/project-gate-view.js";
import type { ProjectDecision } from "../../session/session-project.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createAttachmentInbox } from "../attachments/inbox.js";
import { CHANNEL_RESTRICTED_NOTICE } from "../channel-egress.js";
import { handleInboundText, type InboundContext } from "./inbound-handler.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";

/** Issue #39: `/plan` and the after-turn gate notice, through `handleInboundText`. */
const OWNER = 42;
const CHAT = 100;

describe("Telegram project gate", () => {
  let dir: string;
  let view: ProjectGateView | undefined;
  let messages: string[];
  let decisions: ProjectDecision[];
  let sent: string[];
  let withholdProject: boolean;
  let ctx: InboundContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-project-"));
    view = undefined;
    messages = [];
    decisions = [];
    sent = [];
    withholdProject = false;
    const sessions: SessionState[] = [];
    const runtime = {
      createSession: () => {
        const s = createEmptySessionState({ id: `s-${sessions.length + 1}`, workingDir: "/tmp/test" });
        sessions.push(s);
        return s;
      },
      sessionStore: { load: (id: string) => sessions.find((s) => s.id === id) ?? null },
      turnController: { isBusy: () => false },
      runTurn: async (session: SessionState, text: string, opts?: { eventHook?: (e: AgentLoopEvent) => void }) => {
        messages.push(text);
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
});
