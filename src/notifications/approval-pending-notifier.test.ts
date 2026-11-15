import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalGate } from "../approval/approval-gate.js";
import type { ApprovalPendingNotifyConfig } from "../config/index.js";
import {
  ApprovalPendingNotifier,
  formatApprovalPendingNotice,
  type ApprovalPendingNotifierDeps,
  type OwnerNoticeSender,
} from "./approval-pending-notifier.js";

const MINUTE = 60_000;

function sender(result = "sent"): OwnerNoticeSender & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    sendOwnerNotice: vi.fn(async (text: string) => {
      texts.push(text);
      return result;
    }),
  };
}

function setup(over: Partial<Omit<ApprovalPendingNotifierDeps, "settings">> & {
  settings?: Partial<ApprovalPendingNotifyConfig>;
} = {}) {
  const telegram = sender();
  const discord = sender();
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const { settings, ...rest } = over;
  const notifier = new ApprovalPendingNotifier({
    settings: () => ({ enabled: true, afterMinutes: 5, channel: "auto", ...settings }),
    offline: () => false,
    isPrivate: () => false,
    channelOwned: () => false,
    telegram: () => telegram,
    discord: () => discord,
    logger,
    ...rest,
  });
  const gate = new ApprovalGate({ emit: () => undefined });
  gate.setPendingObserver(notifier);
  const ask = (approvalId = "a1", extra: Record<string, unknown> = {}) =>
    gate.request({
      approvalId,
      sessionId: "s1",
      tool: "os.shell.run",
      category: "shell",
      reason: "run a command",
      preview: "curl -H 'Authorization: Bearer sk-secret-123' https://x",
      affectedResources: ["/home/me/.ssh/id_rsa"],
      workdir: "/home/me/projects/rocket",
      ...extra,
    });
  return { notifier, gate, telegram, discord, logger, ask };
}

describe("ApprovalPendingNotifier", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one message once the prompt has waited afterMinutes", async () => {
    const { telegram, discord, ask } = setup();
    void ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1);
    expect(telegram.texts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram.texts).toEqual([
      "atomic-agent is waiting for your approval for 5 min: shell command (os.shell.run) in rocket. Answer it in the app.",
    ]);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(telegram.texts).toHaveLength(1);
    expect(discord.texts).toEqual([]);
  });

  it("sends nothing for a prompt answered, denied or aborted in time", async () => {
    const { gate, telegram, ask } = setup();
    const answered = ask("a1");
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    gate.resolve({ approvalId: "a1", approved: true });
    await answered;
    const denied = ask("a2");
    gate.denyPendingForSession("s1", "switched away");
    await denied;
    const controller = new AbortController();
    const aborted = gate.request(
      { approvalId: "a3", sessionId: "s1", tool: "t", category: "shell", reason: "r" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(aborted).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(telegram.texts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is off by default: no timer at all", async () => {
    const { telegram, ask } = setup({ settings: { enabled: false } });
    void ask();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(telegram.texts).toEqual([]);
  });

  it("sends nothing while offline", async () => {
    const { telegram, discord, logger, ask } = setup({ offline: () => true });
    void ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(telegram.sendOwnerNotice).not.toHaveBeenCalled();
    expect(discord.sendOwnerNotice).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("offline"),
      expect.anything(),
    );
  });

  it("never carries the preview, arguments, resources or reason", async () => {
    const { telegram, ask } = setup();
    void ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const text = telegram.texts.join("\n");
    for (const leak of ["sk-secret", "curl", "Bearer", "id_rsa", "run a command", "/home/me"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("says nothing about the action for an incognito chat", async () => {
    const { telegram, ask } = setup({ isPrivate: () => true });
    void ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(telegram.texts).toEqual([
      "atomic-agent is waiting for your approval for 5 min. Answer it in the app.",
    ]);
  });

  it("no running channel is a no-op with a debug log", async () => {
    const { logger, ask } = setup({ telegram: () => null, discord: () => null });
    void ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("no running channel"),
      expect.anything(),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("auto falls back to Discord when Telegram is not up; an explicit channel does not", async () => {
    const down = sender("channel_not_up");
    const auto = setup({ telegram: () => down });
    void auto.ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(auto.discord.texts).toHaveLength(1);

    const pinned = setup({ telegram: () => down, settings: { channel: "telegram" } });
    void pinned.ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(pinned.discord.sendOwnerNotice).not.toHaveBeenCalled();
    expect(pinned.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("no running channel"),
      expect.anything(),
    );

    const onlyDiscord = setup({ settings: { channel: "discord" } });
    void onlyDiscord.ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(onlyDiscord.telegram.sendOwnerNotice).not.toHaveBeenCalled();
    expect(onlyDiscord.discord.texts).toHaveLength(1);
  });

  it("a failed delivery is a warning, not a second channel and not a throw", async () => {
    const failing = sender("delivery_failed");
    const { discord, logger, ask } = setup({ telegram: () => failing });
    void ask();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(discord.sendOwnerNotice).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("skips a session a channel owns: its prompt is already in the owner's DM", async () => {
    const { telegram, discord, ask } = setup({ channelOwned: (id) => id === "s1" });
    void ask();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(telegram.sendOwnerNotice).not.toHaveBeenCalled();
    expect(discord.sendOwnerNotice).not.toHaveBeenCalled();
  });

  it("sends at most one reminder a minute, merging the rest into a count", async () => {
    const { telegram, ask } = setup();
    void ask("a1");
    void ask("a2");
    void ask("a3");
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(telegram.texts).toEqual([
      "atomic-agent is waiting for your approval for 5 min: shell command (os.shell.run) in rocket. Answer it in the app.",
    ]);
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(telegram.texts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(telegram.texts).toEqual([
      "atomic-agent is waiting for your approval for 5 min: shell command (os.shell.run) in rocket. Answer it in the app.",
      "atomic-agent: 2 approvals are waiting for you. Answer them in the app.",
    ]);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(telegram.texts).toHaveLength(2);
  });

  it("a merged reminder leaves out prompts answered while it waited", async () => {
    const { gate, telegram, ask } = setup();
    void ask("a1");
    const second = ask("a2");
    void ask("a3");
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    gate.resolve({ approvalId: "a2", approved: true });
    await second;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(telegram.texts).toHaveLength(2);
    // One left: it gets its own message, not a count of one.
    expect(telegram.texts[1]).toBe(
      "atomic-agent is waiting for your approval for 5 min: shell command (os.shell.run) in rocket. Answer it in the app.",
    );
  });

  it("dispose cancels every waiting timer", async () => {
    const { notifier, telegram, ask } = setup();
    void ask("a1");
    void ask("a2");
    notifier.dispose();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(telegram.texts).toEqual([]);
  });
});

describe("formatApprovalPendingNotice", () => {
  it("leaves out the folder when the request has none", () => {
    expect(
      formatApprovalPendingNotice(
        { tool: "os.fs.write", category: "fs_write_workspace" },
        { minutes: 7, private: false },
      ),
    ).toMatch(/^atomic-agent is waiting for your approval for 7 min: .+ \(os\.fs\.write\)\. Answer it in the app\.$/);
  });

  it("says an ask_user question waits for an answer, not an approval", () => {
    const text = formatApprovalPendingNotice(
      { tool: "ask_user", category: "user_question", workdir: "/tmp/shop" },
      { minutes: 3, private: false },
    );
    expect(text).toBe("atomic-agent is waiting for your answer for 3 min: question for you (ask_user) in shop. Answer it in the app.");
    expect(formatApprovalPendingNotice({ tool: "ask_user", category: "user_question" }, { minutes: 3, private: true }))
      .toBe("atomic-agent is waiting for your answer for 3 min. Answer it in the app.");
  });
});
