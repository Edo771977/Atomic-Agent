import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalGate } from "../../approval/approval-gate.js";
import { ApprovalRouter } from "../../approval/approval-router.js";
import type { ApprovalPendingNotifyConfig } from "../../config/index.js";
import { installApprovalPendingNotifier } from "./runtime-approval-pending.js";

const MINUTE = 60_000;

function wire(over: {
  settings?: Partial<ApprovalPendingNotifyConfig>;
  isIncognito?: (id: string) => boolean;
  anyIncognitoOpen?: () => boolean;
  isChannelOwned?: (id: string) => boolean;
  offline?: () => boolean;
} = {}) {
  const gate = new ApprovalGate({ emit: () => undefined });
  const texts: string[] = [];
  let telegram: { sendOwnerNotice(text: string): Promise<string> } | null = null;
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const handle = installApprovalPendingNotifier({
    approvals: gate,
    readSettings: () => ({ enabled: true, afterMinutes: 2, channel: "auto", ...over.settings }),
    isIncognito: over.isIncognito ?? (() => false),
    anyIncognitoOpen: over.anyIncognitoOpen ?? (() => false),
    isChannelOwned: over.isChannelOwned ?? (() => false),
    resolveTelegram: () => telegram,
    resolveDiscord: () => null,
    logger,
    ...(over.offline ? { offline: over.offline } : {}),
  });
  const connect = () => {
    telegram = { sendOwnerNotice: async (text) => { texts.push(text); return "sent"; } };
  };
  const ask = (id: string) =>
    gate.request({ approvalId: id, sessionId: "s", tool: "verify.run", category: "shell", reason: "r", workdir: "/w/app" });
  return { gate, texts, connect, ask, handle, logger };
}

describe("installApprovalPendingNotifier", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends nothing for a session the approval router hands to a channel", async () => {
    const router = new ApprovalRouter(() => undefined);
    const unsubscribe = router.setForSession("s", () => undefined);
    const { texts, connect, ask } = wire({ isChannelOwned: (id) => router.isRouted(id) });
    connect();
    void ask("a1");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(texts).toEqual([]);
    unsubscribe();
    void ask("a2");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(texts).toHaveLength(1);
  });

  it("finds a channel connected after install, at fire time", async () => {
    const { texts, connect, ask } = wire();
    void ask("a1");
    connect();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(texts).toEqual([
      "atomic-agent is waiting for your approval for 2 min: shell command (verify.run) in app. Answer it in the app.",
    ]);
  });

  it("goes generic while an incognito chat is open, and when the lookup fails", async () => {
    const open = wire({ anyIncognitoOpen: () => true });
    open.connect();
    void open.ask("a1");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(open.texts[0]).toBe("atomic-agent is waiting for your approval for 2 min. Answer it in the app.");

    const broken = wire({ isIncognito: () => { throw new Error("store closed"); } });
    broken.connect();
    void broken.ask("a1");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(broken.texts[0]).toBe("atomic-agent is waiting for your approval for 2 min. Answer it in the app.");
  });

  it("dispose detaches from the gate and drops waiting timers", async () => {
    const { gate, texts, connect, ask, handle } = wire();
    connect();
    void ask("a1");
    handle.dispose();
    void ask("a2");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(texts).toEqual([]);
    expect(gate.pendingCount()).toBe(2);
  });

  it("respects offline mode", async () => {
    const { texts, connect, ask } = wire({ offline: () => true });
    connect();
    void ask("a1");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(texts).toEqual([]);
  });
});
