import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureBacklogRuntime } from "../runtime/composition/project-backlog-test-fixture.js";
import { FIXTURE_SHOT_PATH, fixtureProjectGateView, withFixtureMilestoneEvidence } from "../session/project-gate-view-fixtures.js";
import type { ProjectGateView } from "../session/project-gate-view.js";
import type { ProjectDecision } from "../session/session-project.js";
import { buildStreamEventHook } from "./openai-chat-completions.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/** Issue #39: the fusion project gate over HTTP. The runtime side is stubbed. */
describe("/api/project", () => {
  let harness: Harness;
  let views: Map<string, ProjectGateView>;
  let decide: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    harness = await startTestHarness();
    views = new Map([["s1", fixtureProjectGateView({ kind: "plan" })]]);
    decide = vi.fn((sessionId: string, d: ProjectDecision) => {
      if (sessionId === "busy") return { ok: false, error: { code: "turn-running", message: "wait" } };
      if (sessionId === "capped") return { ok: false, error: { code: "over-cap", message: "over the turn budget", violations: ["turn budget"] } };
      if (sessionId === "review") return { ok: false, error: { code: "review-open", message: "tests needs an accept", blocks: [{ taskId: "tests", reason: "needs-changes" }] } };
      const view = views.get(sessionId);
      if (view === undefined) return { ok: false, error: { code: "no-project", message: "no project" } };
      if (d.version !== view.version) return { ok: false, error: { code: "stale-version", message: "the plan changed" } };
      if (!view.allowedVerdicts.includes(d.verdict)) return { ok: false, error: { code: "verdict-not-allowed", message: "not here" } };
      const next = fixtureProjectGateView({ kind: "none" }, { version: (view.version ?? 0) + 1, expectation: { kind: "run_milestone", id: "m1" } });
      views.set(sessionId, next);
      return { ok: true, project: { milestones: [], gate: { kind: "none" } }, view: next };
    });
    Object.assign(harness.runtime, {
      projectState: (id: string) => views.get(id) ?? null,
      projectDecision: decide,
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const post = async (body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${harness.baseUrl}/api/project/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("GET returns the session's view", async () => {
    const res = await fetch(`${harness.baseUrl}/api/project?session=s1`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { session_id: string; view: ProjectGateView };
    expect(json.session_id).toBe("s1");
    expect(json.view.gate).toEqual({ kind: "plan" });
    expect(json.view.allowedVerdicts).toContain("cheaper");
  });

  it("GET carries a milestone's attachments and criteria facts (issue #40)", async () => {
    views.set("s1", withFixtureMilestoneEvidence(fixtureProjectGateView({ kind: "milestone", id: "m1" })));
    const json = (await (await fetch(`${harness.baseUrl}/api/project?session=s1`)).json()) as { view: ProjectGateView };
    expect(json.view.milestones[0]).toMatchObject({
      attachments: [{ path: FIXTURE_SHOT_PATH, caption: "The board at start", criteria: ["c1"] }],
      criteriaFacts: [{ id: "c1", state: "passed" }, { id: "c2", state: "unverified", why: "no vision-capable reviewer" }],
    });
    expect(json.view.brief!.criteria).toEqual([{ id: "c1", text: "Runs in a browser" }, { id: "c2", text: "Ten levels" }]);
  });

  it("GET without a project is 404; without ?session= is 400", async () => {
    expect((await fetch(`${harness.baseUrl}/api/project?session=nope`)).status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/api/project`)).status).toBe(400);
  });

  it("POST approves at the current version and answers with the new view", async () => {
    const r = await post({ session: "s1", gate: { kind: "plan" }, version: 3, verdict: "approve" });
    expect(r.status).toBe(200);
    expect((r.json.view as ProjectGateView).gate).toEqual({ kind: "none" });
    expect(r.json.continue_message).toBe('I approved. Continue with milestone "Base".');
    expect(decide).toHaveBeenCalledWith("s1", { gate: { kind: "plan" }, version: 3, verdict: "approve" });
  });

  it("POST passes edits and a milestone note through", async () => {
    views.set("s1", fixtureProjectGateView({ kind: "milestone", id: "m1" }, { allowedVerdicts: ["approve", "edit", "cancel"] }));
    const r = await post({ session: "s1", gate: { kind: "milestone", id: "m1" }, version: 3, verdict: "edit", edits: { note: "bigger tiles" } });
    expect(r.status).toBe(200);
    expect(decide).toHaveBeenCalledWith("s1", { gate: { kind: "milestone", id: "m1" }, version: 3, verdict: "edit", edits: { note: "bigger tiles" } });
    views.set("s1", fixtureProjectGateView({ kind: "plan" }));
    await post({ session: "s1", gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { rows: [{ taskId: "t1", worker: "prov-c:model-c", reviewer: null }] } });
    expect(decide).toHaveBeenLastCalledWith("s1", expect.objectContaining({ edits: { rows: [{ taskId: "t1", worker: "prov-c:model-c", reviewer: null }] } }));
  });

  it("POST passes a brief edit's criteria, as text or with ids, through", async () => {
    views.set("s1", fixtureProjectGateView({ kind: "brief" }, { version: 2 }));
    const criteria = ["Runs offline", { id: "keys", text: "Arrow keys steer" }];
    const r = await post({ session: "s1", gate: { kind: "brief" }, version: 2, verdict: "edit", edits: { brief: { successCriteria: criteria } } });
    expect(r.status).toBe(200);
    expect(decide).toHaveBeenLastCalledWith("s1", expect.objectContaining({ edits: { brief: { successCriteria: criteria } } }));
    const bad = await post({ session: "s1", gate: { kind: "brief" }, version: 2, verdict: "edit", edits: { brief: { successCriteria: [{ id: "x" }] } } });
    expect(bad.status).toBe(400);
  });

  it("POST on a stale version is 409 with the current view", async () => {
    const r = await post({ session: "s1", gate: { kind: "plan" }, version: 2, verdict: "approve" });
    expect(r.status).toBe(409);
    expect((r.json.error as { code: string }).code).toBe("stale-version");
    expect((r.json.view as ProjectGateView).version).toBe(3);
  });

  it("POST while a turn runs is 409 turn-running; over a hard cap is 422", async () => {
    views.set("busy", fixtureProjectGateView({ kind: "plan" }));
    views.set("capped", fixtureProjectGateView({ kind: "plan" }));
    const busy = await post({ session: "busy", gate: { kind: "plan" }, version: 3, verdict: "approve" });
    expect(busy.status).toBe(409);
    expect((busy.json.error as { code: string }).code).toBe("turn-running");
    expect((await post({ session: "capped", gate: { kind: "plan" }, version: 3, verdict: "approve" })).status).toBe(422);
  });

  it("POST over an open review is 409 review-open, with the blocks (issue #98)", async () => {
    views.set("review", fixtureProjectGateView({ kind: "plan" }));
    const r = await post({ session: "review", gate: { kind: "plan" }, version: 3, verdict: "approve" });
    expect(r.status).toBe(409);
    expect((r.json.error as { code: string }).code).toBe("review-open");
  });

  it("POST with a bad verdict or body is 400 and never reaches the runtime", async () => {
    expect((await post({ session: "s1", gate: { kind: "plan" }, version: 3, verdict: "yolo" })).status).toBe(400);
    expect((await post({ session: "s1", gate: { kind: "plan" }, version: "3", verdict: "approve" })).status).toBe(400);
    expect((await post({ session: "s1", gate: { kind: "elsewhere" }, version: 3, verdict: "approve" })).status).toBe(400);
    expect((await post({ gate: { kind: "plan" }, version: 3, verdict: "approve" })).status).toBe(400);
    expect((await post({ session: "s1", gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { rows: "all" } })).status).toBe(400);
    expect((await post({ session: "s1", gate: { kind: "plan" }, version: 3, verdict: "edit", edits: { note: "x".repeat(2001) } })).status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it("POST with a verdict the gate does not take is 400", async () => {
    views.set("s1", fixtureProjectGateView({ kind: "brief" }));
    const r = await post({ session: "s1", gate: { kind: "brief" }, version: 3, verdict: "cheaper" });
    expect(r.status).toBe(400);
  });

  it("POST for a session without a project is 404", async () => {
    expect((await post({ session: "nope", gate: { kind: "plan" }, version: 3, verdict: "approve" })).status).toBe(404);
  });

  it("forwards project_gate on /api/events, replaying an open gate on connect", async () => {
    const view = fixtureProjectGateView({ kind: "plan" });
    harness.handle.projectGateBus.publish({ type: "project_gate", sessionId: "s1", view });
    const stream = new AbortController();
    const res = await fetch(`${harness.baseUrl}/api/events`, { signal: stream.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("event: project_gate")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    stream.abort();
    await reader.cancel().catch(() => undefined);
    expect(text).toContain("event: project_gate");
    expect(text).toContain('"session_id":"s1"');
    expect(text).toContain('"allowedVerdicts":["approve","edit","cheaper","quality","cancel"]');
  });
});

describe("project_gate on the chat stream", () => {
  const env = (extensionsEnabled: boolean) =>
    ({ completionId: "c", created: 0, session: { id: "s1" }, request: { model: "m", extensionsEnabled } }) as never;

  it("is a named extension frame with the full view", () => {
    const written: Array<{ name: string | null; payload: unknown }> = [];
    const hook = buildStreamEventHook({ closed: false, writeEvent: (name: string | null, payload: unknown) => { written.push({ name, payload }); } } as never, env(true));
    const view = fixtureProjectGateView({ kind: "plan" });
    hook({ type: "project_gate", sessionId: "s1", view });
    expect(written).toEqual([{ name: "project_gate", payload: { object: "atomic.project_gate", session_id: "s1", view } }]);
  });

  it("stays off a plain OpenAI stream", () => {
    const written: unknown[] = [];
    const hook = buildStreamEventHook({ closed: false, writeEvent: (_n: string | null, p: unknown) => { written.push(p); } } as never, env(false));
    hook({ type: "project_gate", sessionId: "s1", view: fixtureProjectGateView({ kind: "plan" }) });
    expect(written).toEqual([]);
  });
});

/** Issue #111 review: the person's backlog call over HTTP, through the runtime's guards. */
describe("/api/project/backlog", () => {
  let harness: Harness;
  let calls: Array<[string, unknown]>;

  beforeEach(async () => {
    harness = await startTestHarness();
    calls = [];
    Object.assign(harness.runtime, {
      projectState: (id: string) => (id === "s1" || id === "busy" ? fixtureProjectGateView({ kind: "plan" }) : null),
      projectBacklogDecision: (id: string, d: unknown) => {
        calls.push([id, d]);
        if (id === "busy") return { ok: false, error: { code: "turn-running", message: "wait" } };
        return { ok: true, project: { milestones: [], gate: { kind: "plan" } }, view: fixtureProjectGateView({ kind: "plan" }) };
      },
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const post = async (body: unknown) => {
    const res = await fetch(`${harness.baseUrl}/api/project/backlog`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("takes the person's promote, drop or reopen and answers with the view", async () => {
    const ok = await post({ session: "s1", item: "b2", state: "promoted" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ session_id: "s1", view: { gate: { kind: "plan" } } });
    expect(calls).toEqual([["s1", { id: "b2", state: "promoted" }]]);
  });

  it("checks the displayed fingerprint against project.json and returns the refreshed view", async () => {
    const fixture = fixtureBacklogRuntime("s1");
    Object.assign(harness.runtime, fixture.runtime);
    try {
      const get = async () => (await (await fetch(`${harness.baseUrl}/api/project?session=s1`)).json()) as { view: ProjectGateView };
      const send = (state: string, expectedFingerprint?: string) => post({ session: "s1", item: "b1", state, expectedFingerprint });
      const shown = (await get()).view.backlog!.items[0]!;
      expect(shown.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect((await send("promoted", shown.fingerprint)).status).toBe(200);
      const promoted = (await get()).view.backlog!.items[0]!;

      fixture.renameItem("Light theme");
      const stale = await send("dropped", promoted.fingerprint);
      expect(stale.status).toBe(409);
      expect(stale.json).toMatchObject({
        error: { code: "stale-view" },
        view: { backlog: { items: [{ title: "Light theme", state: "open", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }] } },
      });
      const malformed = await send("dropped", "g".repeat(64));
      expect(malformed.status).toBe(400);
      expect(malformed.json).toMatchObject({ error: { message: expect.stringContaining("expectedFingerprint") } });
      expect((await send("dropped")).status).toBe(200);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses a malformed call, a running turn and a session without a project", async () => {
    expect((await post({ session: "s1", item: "b2", state: "kept" })).status).toBe(400);
    expect((await post({ session: "s1", state: "dropped" })).status).toBe(400);
    expect((await post({ session: "busy", item: "b2", state: "dropped" })).status).toBe(409);
    expect((await post({ session: "nope", item: "b2", state: "dropped" })).status).toBe(404);
  });
});
