import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureProjectGateView } from "../session/project-gate-view-fixtures.js";
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
