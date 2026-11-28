import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Scheduler, type SchedulerClock } from "./scheduler.js";
import { createSchedulerLeadership, SCHEDULER_LOCK_FILE, TELEGRAM_LOCK_FILE } from "./scheduler-leadership.js";

it("W2 waits a tick after the Telegram owner acquires the real scheduler lock", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "w2-owner-"));
  const starts: number[] = [];
  const schedulers: Scheduler[] = [];
  const make = (pid: number, telegramWanted: boolean) => {
    let tick = () => {};
    const clock: SchedulerClock = { now: () => 1, setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {} };
    const leadership = createSchedulerLeadership({ stateDir, pid, telegramWanted: () => telegramWanted, isAlive: () => true });
    const scheduler = new Scheduler({ clock, leadership, tickMs: 5_000, batch: 1,
      taskRunner: { runDue: vi.fn().mockResolvedValue({ drained: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, retried: 0, retryPending: 0, nextRetryAt: null }) },
      sidecars: [{ tick: async () => {
        expect(readFileSync(join(stateDir, SCHEDULER_LOCK_FILE), "utf8")).toBe(String(pid));
        starts.push(pid);
      } }],
    });
    schedulers.push(scheduler);
    scheduler.start();
    return () => tick();
  };
  try {
    const old = make(1001, false);
    const owner = make(1002, true);
    old(); owner(); old();
    expect(starts).toEqual([1001]);
    writeFileSync(join(stateDir, TELEGRAM_LOCK_FILE), "1002");
    owner();
    expect(readFileSync(join(stateDir, SCHEDULER_LOCK_FILE), "utf8")).toBe("1002");
    expect(starts).toEqual([1001]);
    old(); owner(); old();
    expect(starts).toEqual([1001, 1002]);
    owner();
    expect(starts).toEqual([1001, 1002, 1002]);
  } finally {
    await Promise.all(schedulers.map((s) => s.stop()));
    rmSync(stateDir, { recursive: true, force: true });
  }
});
