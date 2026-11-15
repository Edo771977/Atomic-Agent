import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configuration from "../../config/index.js";
import { AnalyticsStateStore, TurnUsageMeter } from "../../analytics/index.js";
import {
  createEmptySessionState,
  createFusionWorkerSession,
  readSessionFusionDirector,
  withSessionFusionDirector,
  type SessionState,
} from "../../session/index.js";
import type { RunTurnOptions, RunTurnResult } from "../../agent/agent-loop.js";
import { LlamaServerClient } from "../../llm/llama-server-client.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import { parseTeamMember } from "../../llm/run-mode/fusion-team.js";
import { resolveLlmConfig } from "../../llm/provider/registry/provider-types.js";
import { isProviderNotAllowed } from "../../llm/provider-policy.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { TurnController } from "../turn-controller.js";
import { SteeringInbox } from "../steering-inbox.js";
import { createSessionProviderPolicy } from "../session-provider-policy.js";
import { createSessionTeamChoices } from "../session-director.js";
import { createRuntimeTraces } from "./runtime-traces.js";
import { connectRuntimeProviders } from "./runtime-inference.js";
import { createRuntimeTurnService, prepareRuntimeTurnState, type RuntimeTurnDependencies } from "./runtime-turn-service.js";

function result(state: SessionState, options: RunTurnOptions): RunTurnResult {
  return {
    session: { ...state, turns: [...state.turns, { kind: "user", text: options.userMessage ?? "request", at: 1 }, { kind: "assistant_reply", text: "answer", at: 2 }] },
    reason: "reply", stepCount: 1,
  };
}

describe("a session's fusion director in the turn (issue #37)", () => {
  let dir: string;
  let fixture: Awaited<ReturnType<typeof makeFixture>>;

  async function makeFixture() {
    const config = configuration.loadConfig();
    config.agent.nameSessions = false;
    config.tracing.trace.enabled = false;
    const local = resolveLlmConfig(config).providers[0]!;
    config.llm = {
      activeTextProvider: "local-llama",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto",
      providers: [
        local,
        { id: "cloud-a", kind: "openai-compatible", baseUrl: "https://a.example.invalid/v1", apiKey: "k", defaultChatModel: "model-a" },
        { id: "cloud-b", kind: "openai-compatible", baseUrl: "https://b.example.invalid/v1", apiKey: "k", defaultChatModel: "model-x" },
      ],
      runMode: {
        mode: "fusion",
        fusion: {
          orchestratorProvider: "cloud-a",
          workerProvider: "local-llama",
          team: { directors: ["cloud-a:model-a", "cloud-b:model-b"] },
        },
      },
    } as never;
    vi.spyOn(configuration, "getConfig").mockImplementation(() => config);
    const logger = new StructuredLogger({ level: "debug", sinks: [] });
    const traces = createRuntimeTraces(config, {}, logger);
    const providers = await connectRuntimeProviders(config, logger, { llama: new LlamaServerClient(), modelAlias: null }, { getLiveProfile: () => PLAIN_INSTRUCT_PROFILE, getLiveModelId: () => null });
    const rows = new Map<string, SessionState>();
    const sessionTeam = createSessionTeamChoices();
    const seen: Array<{ director: string | null; effective: string; orchestrator: string | null }> = [];
    const loop = { runTurn: vi.fn(async (value: SessionState, options: RunTurnOptions) => {
      const mode = providers.resolveCurrentRunMode(sessionTeam.get(value.id));
      seen.push({ director: sessionTeam.get(value.id)?.director?.ref ?? null, effective: mode.effective, orchestrator: mode.orchestratorProviderId });
      return result(value, options);
    }) };
    const setTurnPrimary = vi.fn();
    const deps: RuntimeTurnDependencies = {
      sessions: {
        sessionStore: {
          save: (v) => { rows.set(v.id, v); }, load: (id) => rows.get(id) ?? null,
          beginTurn: () => true, releaseTurn: () => true,
          finishTurn: (v) => { rows.set(v.id, v); }, checkpointTurn: () => true,
        },
        turnContext: traces.turnContext, turnRequests: new Map(),
      },
      execution: {
        loop, turnController: new TurnController(), steeringInbox: new SteeringInbox(),
        shellJobs: { endSession: () => [], endTurn: () => [] },
        slotManager: { sideCallSlotId: () => 7, release: () => {} },
        llmComplete: async () => { throw new Error("no completion in this test"); },
      },
      inference: { ...providers, sessionTeam, fallbackChain: { standingOverrideFor: () => null, setTurnPrimary } },
      traces: {
        ensureRecorder: () => null, pinSession: () => {}, readContextUsage: () => undefined,
        clearContextUsage: () => {}, releaseSession: () => {},
      },
      telemetry: { observability: { getAnalytics: () => null }, analyticsStateStore: new AnalyticsStateStore(join(dir, "analytics.json")), turnUsageMeter: new TurnUsageMeter() },
      state: prepareRuntimeTurnState(), lifecycle: { isShutdown: () => false }, logger,
    };
    return { config, providers, deps, loop, seen, setTurnPrimary, sessionTeam, service: createRuntimeTurnService(config, deps) };
  }

  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "atomic-turn-director-")); fixture = await makeFixture(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of fixture.providers.providerRegistry.listIds()) await fixture.providers.providerRegistry.getProvider(id)?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const member = (ref: string) => parseTeamMember(ref)!;
  function session(id = "session", metadata: Record<string, unknown> = {}): SessionState {
    return { ...createEmptySessionState({ id, workingDir: dir }), metadata };
  }

  it("runs a stamped director as the turn's primary and its model, without touching the config", async () => {
    const output = await fixture.service.executeTurn(session("s", withSessionFusionDirector({}, member("cloud-b:model-b"), 1)), "request");
    expect(fixture.setTurnPrimary).toHaveBeenCalledWith("s", "cloud-b");
    expect(fixture.seen).toEqual([{ director: "cloud-b:model-b", effective: "fusion", orchestrator: "cloud-b" }]);
    // Not pinned: the fallback chain still serves the turn.
    expect(fixture.loop.runTurn.mock.calls[0]?.[1]).not.toHaveProperty("providerId");
    expect(output.session.metadata?.llm).toEqual({ providerId: "cloud-b", chatModel: "model-b", perTurn: true });
    expect(output.session.metadata?.llmRoute).toMatchObject({ mode: "fusion", main: { providerId: "cloud-b", model: "model-b" }, director: "cloud-b:model-b" });
    expect(resolveLlmConfig(fixture.config).activeTextProvider).toBe("local-llama");
    // Released after the turn: nothing ambient outlives it.
    expect(fixture.sessionTeam.get("s")).toBeUndefined();
    expect(fixture.setTurnPrimary).toHaveBeenLastCalledWith("s", null);
  });

  it("stamps a director a caller names before the turn, and refuses one the team does not list", async () => {
    const output = await fixture.service.executeTurn(session("s"), "request", { director: "cloud-b:model-b" });
    expect(readSessionFusionDirector(output.session.metadata)?.member).toBe("cloud-b:model-b");
    expect(fixture.setTurnPrimary).toHaveBeenCalledWith("s", "cloud-b");
    await expect(fixture.service.executeTurn(session("t"), "request", { director: "cloud-b:model-z" }))
      .rejects.toThrow(/not a director of the fusion team/);
  });

  it("refuses a stamped director the folder does not allow, with the provider refusal", async () => {
    const sessionProviderPolicy = createSessionProviderPolicy({
      readConfig: () => ({ projects: { roots: [], constraints: { [dir]: { allowedProviders: ["cloud-a", "local-llama"] } } } }),
      loadSession: () => null,
    });
    const service = createRuntimeTurnService(fixture.config, {
      ...fixture.deps, inference: { ...fixture.deps.inference, sessionProviderPolicy },
    });
    const turn = service.executeTurn(session("s", withSessionFusionDirector({}, member("cloud-b:model-b"), 1)), "request");
    await expect(turn).rejects.toSatisfy(isProviderNotAllowed);
    expect(fixture.loop.runTurn).not.toHaveBeenCalled();
  });

  it("auto-picks the only reachable director, stamps it and says so once", async () => {
    const notices: unknown[] = [];
    fixture.config.llm!.runMode!.fusion!.team = { directors: ["cloud-a:model-a"] };
    const service = createRuntimeTurnService(fixture.config, { ...fixture.deps, emitEvent: (_id, event) => { notices.push(event); } });
    const first = await service.executeTurn(session("s"), "request");
    expect(readSessionFusionDirector(first.session.metadata)?.member).toBe("cloud-a:model-a");
    expect(fixture.setTurnPrimary).toHaveBeenCalledWith("s", "cloud-a");
    expect(notices).toEqual([{
      type: "fusion_director_notice", sessionId: "s", member: "cloud-a:model-a", reason: "only",
      text: "fusion director: cloud-a:model-a (the only director available)",
    }]);
    await service.executeTurn(first.session, "again");
    expect(notices).toHaveLength(1);
  });

  it("picks the team's default of several when the caller names none, and says which", async () => {
    const notices: Array<{ reason?: string; text?: string }> = [];
    const service = createRuntimeTurnService(fixture.config, { ...fixture.deps, emitEvent: (_id, event) => { notices.push(event as never); } });
    const output = await service.executeTurn(session("s"), "request");
    expect(readSessionFusionDirector(output.session.metadata)?.member).toBe("cloud-a:model-a");
    expect(notices).toMatchObject([{ reason: "default", text: "fusion director: cloud-a:model-a (the team's default of 2 directors)" }]);
  });

  it("picks nothing and says nothing outside the fusion mode", async () => {
    const notices: unknown[] = [];
    fixture.config.llm!.runMode!.mode = "cloud";
    const service = createRuntimeTurnService(fixture.config, { ...fixture.deps, emitEvent: (_id, event) => { notices.push(event); } });
    const output = await service.executeTurn(session("s"), "request");
    expect(notices).toEqual([]);
    expect(readSessionFusionDirector(output.session.metadata)).toBeNull();
  });

  it("says once that a Codex director's own tasks go to the workers", async () => {
    const notices: Array<{ reason?: string; text?: string }> = [];
    fixture.config.llm!.providers.push({ id: "codex", kind: "subscription-cli", subscriptionCli: { cli: "codex" }, defaultChatModel: "" } as never);
    fixture.config.llm!.runMode!.fusion!.team = { directors: ["cloud-a:model-a", "codex:model-c"] };
    await fixture.providers.providerRegistry.mergeProvidersFromConfig(fixture.config, { config: fixture.config, logger: fixture.deps.logger } as never);
    const service = createRuntimeTurnService(fixture.config, { ...fixture.deps, emitEvent: (_id, event) => { notices.push(event as never); } });
    const first = await service.executeTurn(session("s"), "request", { director: "codex:model-c" });
    const second = await service.executeTurn(first.session, "again");
    expect(notices).toEqual([{
      type: "fusion_director_notice", sessionId: "s", member: "codex:model-c", reason: "codex-direct-tasks",
      text: "codex director: tasks for the director itself (model: \"orchestrator\") go to the workers",
    }]);
    // A switch away and back says it again: the route changed.
    const away = await service.executeTurn(second.session, "x", { director: "cloud-a:model-a" });
    await service.executeTurn(away.session, "y", { director: "codex:model-c" });
    expect(notices.filter((n) => n.reason === "codex-direct-tasks")).toHaveLength(2);
  });

  it("tells the model in a route note when the session's director changed", async () => {
    const first = await fixture.service.executeTurn(session("s"), "one", { director: "cloud-a:model-a" });
    await fixture.service.executeTurn(first.session, "two", { director: "cloud-b:model-b" });
    expect(fixture.loop.runTurn.mock.calls[1]?.[1].routeNote).toContain("Fusion director: cloud-b:model-b (previously cloud-a:model-a).");
  });

  it("without a team runs as before: no director, the configured primary", async () => {
    fixture.config.llm!.runMode!.fusion!.team = undefined as never;
    const output = await fixture.service.executeTurn(session("s"), "request");
    expect(fixture.setTurnPrimary).toHaveBeenCalledWith("s", null);
    expect(fixture.seen[0]).toMatchObject({ director: null, effective: "local" });
    expect(readSessionFusionDirector(output.session.metadata)).toBeNull();
  });

  it("a fusion worker's turn borrows its parent's director", async () => {
    let parentDirector: string | undefined;
    let workerDirector: string | undefined;
    fixture.loop.runTurn.mockImplementationOnce(async (value: SessionState, options: RunTurnOptions) => {
      parentDirector = fixture.sessionTeam.get(value.id)?.director?.ref;
      const worker = createFusionWorkerSession({ workingDir: tmpdir(), meta: { parentSessionId: value.id, taskId: "t" } });
      fixture.loop.runTurn.mockImplementationOnce(async (w: SessionState, o: RunTurnOptions) => {
        workerDirector = fixture.sessionTeam.get(w.id)?.director?.ref;
        return result(w, o);
      });
      await fixture.service.executeTurn(worker, "brief", { providerId: "local-llama" });
      return result(value, options);
    });
    await fixture.service.executeTurn(session("p", withSessionFusionDirector({}, member("cloud-b:model-b"), 1)), "request");
    expect(parentDirector).toBe("cloud-b:model-b");
    expect(workerDirector).toBe("cloud-b:model-b");
  });
});
