import { describe, expect, it, vi } from "vitest";

import type { RuntimeProjectDecisionResult } from "../../runtime/project-decision-contract.js";
import { fixtureProjectGateView } from "../../session/project-gate-view-fixtures.js";
import type { ProjectGateBacklog, ProjectGateView } from "../../session/project-gate-view.js";
import type { ProjectBacklogDecision } from "../../session/project-backlog.js";
import { runBacklogCommand, type BacklogCommand } from "./backlog-command.js";

const items: ProjectGateBacklog["items"] = [
  { id: "b1", title: "PDF <export> & reports", condition: "When the report ships\u202e", note: "Private\nreports", createdAt: 1, source: "director", state: "open" },
  { id: "b2", title: "Invoice exports", createdAt: 2, source: "director", state: "promoted" },
  { id: "b3", title: "Email receipts", createdAt: 3, source: "director", state: "promoted", plannedIn: 7 },
  { id: "b4", title: "Fax receipts", createdAt: 4, source: "director", state: "dropped" },
];
const backlog: ProjectGateBacklog = {
  items, open: 1, seeds: [], promoted: [],
  stale: [{ id: "b1", state: "dropped", reason: "changed" }, { id: "b5", state: "promoted", reason: "removed" }],
};
const project = fixtureProjectGateView({ kind: "none" }, { backlog, version: null });

function harness(initial: ProjectGateView | null = project) {
  let view = initial;
  const runtime = {
    projectState: vi.fn((): ProjectGateView | null => view),
    projectBacklogDecision: vi.fn((_session: string, _decision: ProjectBacklogDecision): RuntimeProjectDecisionResult => ({
      ok: true as const,
      project: { milestones: [], gate: { kind: "none" as const } },
      view: project,
    })),
  };
  const run = (command: BacklogCommand, args: string[] = [], extra: { busy?: boolean; sessionId?: string; chatKey?: string } = {}) =>
    runBacklogCommand(command, args, { runtime, sessionId: "s1", chatKey: "chat1", busy: false, ...extra });
  return { run, runtime, setView: (next: ProjectGateView | null) => { view = next; } };
}

function codeOf(text: string): string {
  const code = text.match(/\b[0-9a-f]{16}\b/)?.[0];
  if (code === undefined) throw new Error("Missing confirmation code");
  return code;
}

describe("Telegram backlog commands", () => {
  it("lists current states, seed conditions, plan adoption and stale calls between gates", () => {
    const h = harness();
    const out = h.run("/backlog");
    expect(out).toMatch(/b1.*PDF <export> & reports.*open/);
    expect(out).toContain("When the report ships\\u202e");
    expect(out).toMatch(/b2.*promoted.*not in any plan/);
    expect(out).toMatch(/b3.*promoted.*plan v7/);
    expect(out).toMatch(/b4.*dropped/);
    expect(out).toMatch(/b1.*changed/);
    expect(out).toMatch(/b5.*removed/);
    expect(h.runtime.projectBacklogDecision).not.toHaveBeenCalled();
  });

  it.each([["/promote", "b1", "promoted"], ["/drop", "b2", "dropped"], ["/reopen", "b4", "open"], ["/reopen", "b5", "open"]] as const)(
    "only applies %s %s after explicit confirmation", (command, id, state) => {
      const h = harness();
      const preview = h.run(command, [id]);
      expect(preview).toContain(`${command} ${id} ${codeOf(preview)}`);
      expect(h.runtime.projectBacklogDecision).not.toHaveBeenCalled();
      expect(h.run(command, [id, codeOf(preview)])).toMatch(/Updated backlog/);
      expect(h.runtime.projectBacklogDecision).toHaveBeenCalledWith("s1", { id, state, expectedFingerprint: expect.any(String) });
    },
  );

  it("pins confirmation to the action, chat, session, item content and status without needing a gate version", () => {
    const h = harness();
    const preview = h.run("/promote", ["b1"]);
    expect(preview).toContain("Private\\nreports");
    const code = codeOf(preview);
    expect(h.run("/drop", ["b1", code])).toMatch(/preview.*again/i);
    expect(h.run("/promote", ["b1", code], { sessionId: "s2" })).toMatch(/preview.*again/i);
    expect(h.run("/promote", ["b1", code], { chatKey: "chat2" })).toMatch(/preview.*again/i);
    const update = (change: Partial<typeof items[number]>) => h.setView({
      ...project, backlog: { ...backlog, items: [{ ...items[0]!, ...change }, ...items.slice(1)] },
    });
    update({ condition: "When the policy is approved" });
    expect(h.run("/promote", ["b1", code])).toMatch(/preview.*again/i);
    update({ state: "dropped" });
    expect(h.run("/promote", ["b1", code])).toMatch(/preview.*again/i);
    expect(h.runtime.projectBacklogDecision).not.toHaveBeenCalled();
  });

  it("reports invalid, missing, cancelled, busy and runtime refusal cases", () => {
    const h = harness();
    expect(h.run("/drop", ["b6"])).toMatch(/no item b6/);
    expect(h.run("/drop", ["b1", "bogus"])).toMatch(/Usage/);
    expect(h.run("/drop", ["b1"], { busy: true })).toMatch(/current turn/);
    h.setView({ ...project, cancelled: true });
    expect(h.run("/drop", ["b1"])).toMatch(/cancelled/);
    h.setView(null);
    expect(h.run("/backlog")).toMatch(/no project record/);
    expect(h.runtime.projectBacklogDecision).not.toHaveBeenCalled();

    h.setView(project);
    const code = codeOf(h.run("/drop", ["b1"]));
    h.runtime.projectBacklogDecision.mockReturnValueOnce({
      ok: false, error: { code: "turn-running", message: "Wait for the current work to finish, then decide." },
    });
    expect(h.run("/drop", ["b1", code])).toMatch(/Backlog unchanged.*current work/);
  });
});
