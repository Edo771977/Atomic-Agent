import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { fixtureProjectGateView } from "../../session/project-gate-view-fixtures.js";
import type { ProjectGateDecision, ProjectGateView } from "../../session/project-gate-view.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createAttachmentInbox } from "../attachments/inbox.js";
import { handleInboundText, type InboundContext } from "./inbound-handler.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";

/** Issue #39: `/plan` and the after-turn gate notice, through `handleInboundText`. */
const OWNER = 42;
const CHAT = 100;

describe("Telegram project gate", () => {
  let dir: string;
  let view: ProjectGateView | undefined;
  let messages: string[];
  let decisions: ProjectGateDecision[];
  let sent: string[];
  let ctx: InboundContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-project-"));
    view = undefined;
    messages = [];
    decisions = [];
    sent = [];
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
      projectState: () => view,
      projectDecision: async (_id: string, d: ProjectGateDecision) => {
        decisions.push(d);
        view = fixtureProjectGateView({ kind: "none" }, { version: 4, expectation: { kind: "run_milestone", id: "m1" } });
        return { ok: true as const, view };
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

  const say = (text: string) =>
    handleInboundText({ from: { id: OWNER }, chat: { id: CHAT, type: "private" }, text, message_id: 1 }, ctx);

  it("tells the owner a gate waits after the turn, and /plan approve continues the work", async () => {
    await say("build a puzzle game");
    expect(sent.at(-2)).toBe("drafted");
    expect(sent.at(-1)).toContain("The project plan waits for your approval");
    expect(sent.at(-1)).toContain("/plan approve");

    await say("/plan approve");
    expect(decisions).toEqual([{ gate: { kind: "plan" }, version: 3, verdict: "approve" }]);
    expect(sent).toContain("Approved the plan (version 3): 2 tasks, $0.12 (+1 unpriced), ~1m30s.");
    expect(messages).toEqual(["build a puzzle game", 'I approved. Continue with milestone "Base".']);
  });
});
