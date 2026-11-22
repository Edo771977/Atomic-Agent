import { afterEach, expect, it, vi } from "vitest";
import * as bootstrap from "../runtime/bootstrap.js";
import * as configuration from "../config/index.js";
import type { AgentLoopEvent } from "../agent/agent-contract.js";
import { fixtureProjectGateView } from "../session/project-gate-view-fixtures.js";
import type { ProjectGateView } from "../session/project-gate-view.js";
import type { ProjectDecision } from "../session/session-project.js";
import { bootstrapSidecar } from "./main.js";

afterEach(() => vi.restoreAllMocks());

/**
 * Issue #39: the sidecar's contract for the desktop's project card —
 * `project_gate` events with the full view, and the `project_decision`
 * and `get_project` requests. The runtime side is stubbed.
 */
it("forwards project_gate for its session and takes project_decision", async () => {
  const config = configuration.loadConfig();
  config.llm = { activeTextProvider: "cloud", activeEmbeddingProvider: "cloud", toolTransport: "auto", providers: [{ id: "cloud", kind: "openai-compatible", baseUrl: "https://paid.invalid" }] };
  vi.spyOn(configuration, "getConfig").mockReturnValue(config);
  let forward: ((event: AgentLoopEvent) => void) | undefined;
  let view: ProjectGateView | undefined = fixtureProjectGateView({ kind: "plan" });
  const decisions: Array<[string, ProjectDecision]> = [];
  vi.spyOn(bootstrap, "createAgentRuntime").mockImplementation(async (options) => {
    forward = (event) => options.handlers?.onAgentEvent?.(event, "chat");
    return {
      createSession: () => ({ id: "chat" }),
      shutdown: async () => {},
      projectState: (id: string) => (id === "chat" ? (view ?? null) : null),
      projectDecision: (id: string, d: ProjectDecision) => {
        decisions.push([id, d]);
        if (d.version !== 3) return { ok: false, error: { code: "stale-version", message: "the plan changed" } };
        view = fixtureProjectGateView({ kind: "none" }, { version: 4, expectation: { kind: "run_milestone", id: "m1" } });
        return { ok: true, project: { milestones: [], gate: { kind: "none" as const } }, view };
      },
    } as unknown as bootstrap.AgentRuntime;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const streams = [process.stdin, process.stdin, process.stdout, process.stdout];
  const names = ["data", "end", "error", "close"];
  const kept = names.map((name, i) => streams[i]!.listeners(name));
  const sidecar = await bootstrapSidecar();
  const emitted = vi.spyOn(sidecar.protocol, "emitEvent");
  const responses = new Map<string, { ok: boolean; payload: unknown }>();
  vi.spyOn(sidecar.protocol, "respond").mockImplementation((id, payload, ok = true) => {
    responses.set(id, { ok, payload });
    return { kind: "response", id: `response-${id}`, correlationId: id, ok, payload };
  });
  const send = (id: string, type: string, payload: unknown) =>
    process.stdin.emit("data", JSON.stringify({ kind: "request", id, type, payload }) + "\n");
  const response = async (id: string) => {
    await vi.waitFor(() => expect(responses.has(id)).toBe(true));
    return responses.get(id)!;
  };
  try {
    send("start", "start_session", { workingDir: process.cwd() });
    await response("start");

    const gate = fixtureProjectGateView({ kind: "plan" });
    forward?.({ type: "project_gate", sessionId: "chat", view: gate });
    forward?.({ type: "project_gate", sessionId: "other", view: gate });
    expect(emitted.mock.calls.filter(([name]) => name === "project_gate")).toEqual([
      ["project_gate", { sessionId: "chat", view: gate }],
    ]);

    send("get", "get_project", { sessionId: "chat" });
    expect((await response("get")).payload).toEqual({ sessionId: "chat", view: gate });

    send("stale", "project_decision", { sessionId: "chat", gate: { kind: "plan" }, version: 2, verdict: "approve" });
    expect(await response("stale")).toEqual({
      ok: true,
      payload: { ok: false, error: { code: "stale-version", message: "the plan changed" }, view: gate },
    });

    send("bad", "project_decision", { sessionId: "chat", gate: { kind: "plan" }, version: 3, verdict: "yolo" });
    expect((await response("bad")).ok).toBe(false);

    send("ok", "project_decision", { sessionId: "chat", gate: { kind: "plan" }, version: 3, verdict: "approve" });
    const ok = await response("ok");
    expect(ok.payload).toMatchObject({ ok: true, view: { version: 4 }, continueMessage: 'I approved. Continue with milestone "Base".' });
    expect(decisions.at(-1)).toEqual(["chat", { gate: { kind: "plan" }, version: 3, verdict: "approve" }]);

    send("none", "project_decision", { sessionId: "nope", gate: { kind: "plan" }, version: 3, verdict: "approve" });
    expect((await response("none")).payload).toMatchObject({ ok: false, error: { code: "no-project" } });
  } finally {
    for (let i = 0; i < names.length; i++) {
      for (const listener of streams[i]!.listeners(names[i]!)) {
        if (!kept[i]!.includes(listener)) streams[i]!.removeListener(names[i]!, listener as () => void);
      }
    }
    await sidecar.shutdown();
  }
});

it("takes project_backlog_decision, the person's backlog call (issue #111 review)", async () => {
  const config = configuration.loadConfig();
  config.llm = { activeTextProvider: "cloud", activeEmbeddingProvider: "cloud", toolTransport: "auto", providers: [{ id: "cloud", kind: "openai-compatible", baseUrl: "https://paid.invalid" }] };
  vi.spyOn(configuration, "getConfig").mockReturnValue(config);
  let view: ProjectGateView | undefined = fixtureProjectGateView({ kind: "plan" });
  const decisions: Array<[string, ProjectDecision]> = [];
  const backlogCalls: Array<[string, unknown]> = [];
  vi.spyOn(bootstrap, "createAgentRuntime").mockImplementation(async () => {
    return {
      createSession: () => ({ id: "chat" }),
      shutdown: async () => {},
      projectState: (id: string) => (id === "chat" ? (view ?? null) : null),
      projectBacklogDecision: (id: string, d: unknown) => {
        backlogCalls.push([id, d]);
        return { ok: true, project: { milestones: [], gate: { kind: "plan" as const } }, view: fixtureProjectGateView({ kind: "plan" }) };
      },
      projectDecision: (id: string, d: ProjectDecision) => {
        decisions.push([id, d]);
        if (d.version !== 3) return { ok: false, error: { code: "stale-version", message: "the plan changed" } };
        view = fixtureProjectGateView({ kind: "none" }, { version: 4, expectation: { kind: "run_milestone", id: "m1" } });
        return { ok: true, project: { milestones: [], gate: { kind: "none" as const } }, view };
      },
    } as unknown as bootstrap.AgentRuntime;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const streams = [process.stdin, process.stdin, process.stdout, process.stdout];
  const names = ["data", "end", "error", "close"];
  const kept = names.map((name, i) => streams[i]!.listeners(name));
  const sidecar = await bootstrapSidecar();
  const responses = new Map<string, { ok: boolean; payload: unknown }>();
  vi.spyOn(sidecar.protocol, "respond").mockImplementation((id, payload, ok = true) => {
    responses.set(id, { ok, payload });
    return { kind: "response", id: `response-${id}`, correlationId: id, ok, payload };
  });
  const send = (id: string, type: string, payload: unknown) =>
    process.stdin.emit("data", JSON.stringify({ kind: "request", id, type, payload }) + "\n");
  const response = async (id: string) => {
    await vi.waitFor(() => expect(responses.has(id)).toBe(true));
    return responses.get(id)!;
  };
  try {
    send("start", "start_session", { workingDir: process.cwd() });
    await response("start");
    send("b-ok", "project_backlog_decision", { sessionId: "chat", item: "b2", state: "promoted" });
    expect((await response("b-ok")).payload).toMatchObject({ ok: true, view: { version: 3 } });
    expect(backlogCalls).toEqual([["chat", { id: "b2", state: "promoted" }]]);
    send("b-bad", "project_backlog_decision", { sessionId: "chat", item: "b2", state: "kept" });
    expect((await response("b-bad")).ok).toBe(false);
    send("b-none", "project_backlog_decision", { sessionId: "nope", item: "b2", state: "dropped" });
    expect((await response("b-none")).payload).toMatchObject({ ok: false, error: { code: "no-project" } });
  } finally {
    for (let i = 0; i < names.length; i++) {
      for (const listener of streams[i]!.listeners(names[i]!)) {
        if (!kept[i]!.includes(listener)) streams[i]!.removeListener(names[i]!, listener as () => void);
      }
    }
    await sidecar.shutdown();
  }
});
