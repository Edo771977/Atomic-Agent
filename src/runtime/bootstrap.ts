import { SecretKeychain } from "../config/secret-store.js";
import { createProjectReceiptWriter } from "../session/project-receipts.js";
import { completionCostUsd } from "../llm/provider/usage-cost.js";
import { createSessionTeamChoices, resolveSessionReviewer, resolveSessionWorker } from "./session-director.js";
import { createRuntimeProject, liveProjectInputsFrom } from "./composition/runtime-project.js";
import type { ResolvedRunMode } from "../llm/run-mode/index.js";
import { PrefixInvalidationLedger, notePrefixInvalidation } from "../agent/prefix-drift-warning.js";
import { resolveServerTemplatePolicy } from "../llm/server-template-policy.js";
import { createContextCompaction, logCompactionOutcome } from "./context-compaction.js";
import { enhancePrompt, promptEnhancePartition } from "./prompt-enhancer.js";
import { askSideQuestion, sideQuestionPartition } from "./side-question.js";
import { completePlain, PLAIN_COMPLETE_PARTITION, type PlainCompleteInput } from "./plain-complete.js";
import { createBackgroundCompaction } from "./compaction-background.js";
import { createCompactionTokenCounter } from "./compaction-token-counter.js";
import { createWorkspaceLoader } from "./session-workspace.js";
import { prepareRuntimeSkills, recurringTaskTexts, startRuntimeSkillCurator } from "./composition/runtime-skills.js";
import { createRuntimeToolRegistry, registerRuntimeCoreTools, registerRuntimeVisionTools, registerRuntimeImageTools, registerRuntimeVideoTools, registerRuntimeAudioTools, connectRuntimeMcpCatalog, mcpGrammarHookFor, registerRuntimeFusionAndReadScope } from "./composition/runtime-tool-catalog.js";
import { prepareRuntimeSessionStore, installRuntimeSessionDelete, createRuntimeSessionFactories, runtimeProjectStore } from "./composition/runtime-session-services.js";
import { createInterruptedTurns } from "./interrupted-turns.js";
import { prepareRuntimeTurnState, createRuntimeTurnService } from "./composition/runtime-turn-service.js";
import { createIncognitoSessions } from "./incognito-sessions.js";
import { installApprovalPendingNotifier } from "./composition/runtime-approval-pending.js";
import { eraseManagedChatSlots, markPromptCachePrivate } from "../local-llm/index.js";
import { createRuntimeKeepAwake, createRuntimeTaskStores, createRuntimeTaskRunner, createRuntimeScheduler } from "./composition/runtime-task-services.js";
import { connectRuntimeChannels } from "./composition/runtime-channels.js";
import { createRuntimeMailTrigger } from "./composition/runtime-mail-trigger.js";
import { createCrossSessionPolicy } from "./cross-session-policy.js";
import { createOtlpSessionGate } from "./composition/runtime-otlp-gate.js";
import { createOfflineModeControl } from "./composition/runtime-offline-mode.js";
import { stopRunningDownloadWorkers } from "../local-llm/index.js";
import { holdWhileRunning } from "../scheduler/index.js";
import type { AgentRuntime, CreateAgentRuntimeOptions } from "./runtime-contract.js";
export type { AgentRuntime, CreateAgentRuntimeOptions, MemoryEmbeddingReconnect, RuntimeEventHandlers } from "./runtime-contract.js";
export { managedLocalLlmHealthFailureHint } from "./composition/runtime-local-profile.js";
import { createRuntimeObservability } from "./composition/runtime-observability.js";
import { createRuntimeTraces } from "./composition/runtime-traces.js";
import { createRuntimeFusionOutcomes } from "./composition/runtime-fusion-outcomes.js";
import { prepareRuntimeLocalProfile, connectRuntimeLocalProfile } from "./composition/runtime-local-profile.js";
import { connectRuntimeProviders, createRuntimeModelContext, connectRuntimeFallback, createRuntimeProviderReloads, catalogWindowOf } from "./composition/runtime-inference.js";
import { RequestBudgetNotices } from "./request-budget-notices.js";
import { modelWantsStrictTools } from "../llm/provider/model-strict-tools.js";
import { createRuntimeMemoryStores } from "./composition/runtime-memory-stores.js";
import { createMemoryEmbeddingSwitch } from "./composition/runtime-memory-embedding-switch.js";
import { createRuntimeMemoryServices, createRuntimeMemoryConsolidator } from "./composition/runtime-memory-services.js";
import { sessionGroundingSource } from "../memory/name-grounding.js";
import { createRuntimeLifecycle } from "./composition/runtime-lifecycle.js";
import { join, resolve } from "node:path";

import { getConfig } from "../config/index.js";
import { channelNotifyRefusal, createSessionProviderPolicy, egressRefusal, moveSessionFolder, retrySessionSeed, sessionPolicyStamp } from "./session-provider-policy.js";
import { createRuntimeDispatchGuard } from "./composition/runtime-egress-guard.js";
import { fusionWorkerParents } from "./fusion-worker-parents.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import { createSessionReadTaint } from "./session-read-taint.js";
import { describeProviderRestriction, resolveProjectConstraint } from "../llm/provider-policy.js";
import { createConstraintScopeBackfill } from "../memory/memory-constraint-scope.js";
import { fusionPolicyDegradation } from "./fusion-policy-degradation.js";
import { currentProviderPolicy } from "../llm/provider-policy.js";
import { describeLocalModelsValueSources } from "../config/load-config.js";
import type { SessionState } from "../session/session-state.js";
import type { CompletionResult } from "../llm/provider/completion-types.js";
import { estimateTokens } from "../prompt/token-budget.js";

import { TurnController } from "./turn-controller.js";
import { SteeringInbox } from "./steering-inbox.js";

import { TelegramChannel } from "../channels/telegram/index.js";
import { DiscordChannel } from "../channels/discord/index.js";
import { SwarmRegistry } from "../channels/swarm/index.js";
import type { ChannelRegistry } from "../channels/channel-registry.js";

import { installTransportDeadlines } from "../llm/transport-deadlines.js";

import { ApprovalGate } from "../approval/approval-gate.js";
import { ApprovalRulesStore } from "../approval/approval-rules-store.js";

import { ApprovalRouter } from "../approval/approval-router.js";
import { installRiskReviewer } from "./composition/runtime-risk-review.js";

import type { DangerousToolOptions } from "../approval/dangerous-tool.js";

import { PlaywrightBackend } from "../tools/browser/playwright-backend.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { BrowserExtractModelRef } from "../tools/browser/extract-request.js";
import { DeclaredInputsRegistry, ShellJobRegistry } from "../tools/os/index.js";
import { ToolOutputSpill } from "../tools/index.js";
import { registerSessionTools } from "../tools/sessions/index.js";
import {
  FUSION_OUTCOME_JOURNAL_FILE_NAME,
  FUSION_RUNS_DIR_NAME,
  FusionLiveWorkers,
  FusionOutcomeJournal,
  FusionRunStore,
  FusionTurnBudget,
  describeResumableRun,
  resumableRunDetails,
  renderResumeRequest,
} from "../tools/fusion/index.js";

import { resolveLlmConfig } from "../llm/provider/index.js";

import { CostAccumulator } from "../llm/provider/cost-accumulator.js";
import { SessionUsageLedger, forwardWorkerUsage } from "../session/usage-meter.js";
import { DAILY_SPEND_FILE_NAME, DailySpendStore, dailySpendViewFor } from "../session/daily-spend.js";
import { hasPricedCloudLink } from "./resolve-model-pricing.js";

import { ProviderFallbackChain } from "../llm/fallback/index.js";
import { createFallbackChainResolver } from "./fallback-chain-resolver.js";
import { isLocalLinkWithoutModel } from "./local-link-availability.js";
import { explainLocalEngineState, readLocalEngineState } from "./local-engine-state.js";
import { createLocalOutOfMemoryPort, type LocalModelRestarter } from "./local-out-of-memory.js";
import { createRuntimePromptPreview, buildRuntimePromptInput } from "./composition/runtime-prompt-preview.js";
import { captureModelModePolicy, resolveModelMode } from "../llm/model-mode.js";
export { SessionNotFoundError } from "./session-not-found-error.js";
import { SessionNotFoundError } from "./session-not-found-error.js";

import { createLessonLifecycleHook } from "../memory/lessons/lesson-lifecycle-hook.js";

import { createMemoryHealthAnnouncer } from "./announce-memory-health.js";

import { readAtomicMailApiKey } from "../atomic-mail/index.js";
import { buildCapabilities } from "../prompt/capabilities.js";

import type { SkillCatalogEntry, ToolDescriptor } from "../prompt/stable-prefix.js";

import { AgentLoop } from "../agent/agent-loop.js";

import { TurnUsageMeter } from "../analytics/index.js";

import { installGlobalErrorHandlers } from "../error-reporting/index.js";
import { ToolHookEngine, installToolHooks } from "../hooks/index.js";

/**
 * One-stop factory that wires the whole agent runtime. Both the CLI
 * (`atomic-agent run`) and the sidecar (`atomic-agent-sidecar`) go
 * through this function — there is no other way to construct a live
 * AgentLoop. Explicit construction phases share the same root so
 * entry points use the same wiring and lifecycle.
 */
export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const config = getConfig();
  // Before anything can make a request: Node's global `fetch` applies a
  // 300 s deadline of its own under every AbortSignal this codebase
  // arms, which made `firstTokenTimeoutMs`, `streamTotalTimeoutMs`, the
  // `/slots` unreachable budget and a Fusion worker's queue budget all
  // unreachable, and turned a wedged llama-server into a bare
  // `fetch failed` at 306 s. See `installTransportDeadlines`.
  installTransportDeadlines(config);
  const workingDir = resolve(options.workingDir);

  const observability = createRuntimeObservability(config, options);
  const { logger, metrics, analyticsStateStore } = observability;
  // ATO-922: an env override used to beat `config.json` without a trace.
  for (const line of describeLocalModelsValueSources(config.localModels)) {
    logger.info(line);
  }

  // Read the current reporter lazily so a hot-toggle is reflected without
  // re-installing the process-global handlers.
  installGlobalErrorHandlers(observability.getErrorReporter, {
    brokenPipe: options.brokenPipe,
  });

  const {
    setAnalyticsEnabled,
    reportOnboardingStep,
    reportModelConfigured,
    reportLocalEngineFailed,
    reportUiAction,
    interviewInviteIdentity,
    reportInterviewInvite,
  } = observability.createControls();

  const traces = createRuntimeTraces(config, options, logger);
  const { traceBus, turnContext, touchRecorder, dropRecorder, ensureRecorder } = traces;

  const steeringInbox = new SteeringInbox();
  const turnController = new TurnController({
    onHookError: (err, ctxInfo) => {
      logger.warn("turn event hook threw", {
        sessionId: ctxInfo.sessionId,
        origin: ctxInfo.origin,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const { emitAgentLoopEventFor, emitAgentLoopEvent } = traces.createEventRouting(
    turnController, options, observability.getErrorReporter,
  );

  // Memory sub-calls run fire-and-forget and fail without a word. This
  // counts consecutive timeouts / failures per session and sub-call and
  // lifts the first streak into one `memory_health_warning` (see
  // ../memory/docs/formation.md). The session comes from the
  // runner's own outcome, not the ALS frame: reflection settles after
  // `turn_finished`.
  const memoryHealth = createMemoryHealthAnnouncer({
    emit: emitAgentLoopEventFor,
    logger,
  });

  // Cross-provider fallover breaker. Owns no timer — every decision is
  // computed lazily from the wall clock when a turn asks for a provider
  // (../llm/docs/fallback.md). The notice sink lifts each
  // one-shot switch into a `provider_switched` AgentLoopEvent; the logger
  // records every advance, with the failed link's status and message.
  // Set once the provider registry exists (below). Until then the chain
  // is taken from config as before; nothing picks a provider that early.
  let builtProviderIds: (() => readonly string[]) | null = null;
  const fallbackChain = new ProviderFallbackChain({
    resolve: createFallbackChainResolver({
      readLlmConfig: () => resolveLlmConfig(getConfig()),
      builtProviderIds: () => builtProviderIds?.() ?? null,
      linkUnavailable: (llm, id) => isLocalLinkWithoutModel(llm, id, getConfig()),
      logger,
    }),
    noticeSink: (notice) => {
      // The fallback's model, so the turn can say "switched to
      // Gemini (gemini-2.5-flash)" (ATO-483).
      const to = resolveLlmConfig(getConfig()).providers.find((p) => p.id === notice.to);
      const toModel = to?.defaultChatModel ?? to?.model;
      emitAgentLoopEvent({
        type: "provider_switched",
        ...notice,
        ...(notice.direction === "away" && toModel ? { toModel } : {}),
      });
    },
    logger,
  });

  // Approval requests flow through `ApprovalRouter`: per-session
  // handlers (Telegram channel, future Slack/etc.) win, otherwise the
  // host's `onApprovalRequest` callback fires. The fallback closure
  // reads `options.handlers` when an approval arrives. Sessions that
  // need a different handler register with the per-session router.
  const approvalRouter = new ApprovalRouter((request) => {
    options.handlers?.onApprovalRequest?.(request);
  });
  const approvals = new ApprovalGate({
    emit: (request) => approvalRouter.emit(request),
    level: options.approvalLevel,
  });
  // Saved "always allow" / ask / deny rules (ATO-1141): the global file in
  // the state dir, plus ask / deny from a project's own file.
  approvals.setRules(new ApprovalRulesStore({
    stateDir: config.paths.stateDir,
    warn: (message, fields) => logger.warn(message, fields),
  }));
  // Tools are registered with `approvalRequired: true` unconditionally;
  // the gate's approval level carries the boot-time value instead. Every
  // request reaches the gate with its category and the gate decides
  // (auto-approve resolves instantly without emitting a prompt), so the
  // gate stays the single live switch and `runtime.setApprovalLevel` can
  // move the ladder at runtime in both directions — tool registrations
  // copy the boolean and would otherwise freeze a boot-time value
  // forever.
  const dangerous: DangerousToolOptions = {
    approvals,
    approvalRequired: true,
  };
  // PreToolUse / PostToolUse hooks (ATO-493): `<stateDir>/hooks.json` plus
  // hooks of enabled plugins the user let run code. Read per call (cached
  // on mtime), so editing hooks.json needs no restart. A hook's `ask` goes
  // to the same approval gate as the tools' own prompts.
  installToolHooks(new ToolHookEngine({ stateDir: config.paths.stateDir, approvals, logger }));

  // Issue #112. Every local text probe below hangs off this one answer,
  // and it is available here — hundreds of lines before
  // `ProviderRegistry.fromConfig` resolves the active provider —
  // because `resolveLlmConfig` is a pure function of config with no
  // I/O. A cloud-backed boot must not open `/health` or `/props`
  // against a llama-server nobody is routed to: the warnings it prints
  // read as an active-backend failure while the real provider is fine.
  const localProfile = await prepareRuntimeLocalProfile(config, options, logger);
  const { llama, profile, slotManager } = localProfile;
  const browserBackend: BrowserBackend =
    options.overrides?.browserBackend ??
    new PlaywrightBackend({
      userDataDir: config.paths.browserProfileDir,
      channel: config.browser.channel,
      executablePath: config.browser.executablePath,
      headless: config.browser.headlessSetting ?? config.browser.headless,
      profile: config.browser.profile ?? "agent",
      ...(config.browser.maxTabs !== undefined ? { maxTabs: config.browser.maxTabs } : {}),
      workerIsolation: config.browser.workerIsolation ?? "tabs",
      noSandbox: config.browser.noSandbox,
      launchTimeoutMs: config.browser.launchTimeoutMs,
      cdpUrl: config.browser.cdpUrl,
      connect: config.browser.connect,
      userChromeDataDir: config.browser.userChromeDataDir,
    });
  const preparedSkills = await prepareRuntimeSkills(config, workingDir, logger);
  const { skillRegistry } = preparedSkills;

  const capabilities = await buildCapabilities({
    workingDir,
    browserChannel: config.browser.channel,
    // Only an inbox this machine holds the key for is the agent's to use.
    emailAddress: readAtomicMailApiKey() ? config.atomicMail.address : null,
  });

  // Memory-v2 phase 7a — fail-fast clamp/decay validation. The
  // config schema already enforces these ranges, but bootstrap
  // re-asserts so a hand-edited `config.json` with a v16 marker but
  // garbage values cannot smuggle invalid voting params past the
  // runtime. Scenario 7a.C.3 ("bootstrap fails fast on invalid
  // clamp") is pinned by `consolidator-vote.test.ts` indirectly via
  // the schema test, but the explicit guard here covers the
  // post-load codepath where `validateConfigFile` is bypassed.
  if (config.memory.voting.enabled) {
    if (
      !Number.isInteger(config.memory.voting.maxVotePerItem) ||
      config.memory.voting.maxVotePerItem <= 0
    ) {
      throw new Error(
        `bootstrap: memory.voting.maxVotePerItem must be a positive integer (got ${config.memory.voting.maxVotePerItem})`,
      );
    }
    const sd = config.memory.voting.signalDecay;
    if (!(sd > 0 && sd <= 1)) {
      throw new Error(
        `bootstrap: memory.voting.signalDecay must be in (0, 1] (got ${sd})`,
      );
    }
    const sb = config.memory.voting.scoreBlend;
    if (!(sb >= 0 && sb <= 1)) {
      throw new Error(
        `bootstrap: memory.voting.scoreBlend must be in [0, 1] (got ${sb})`,
      );
    }
  }
  const memoryStores = await createRuntimeMemoryStores({
    config, metrics, logger, onProfileEvicted: (eviction) => {
      const sessionId = turnContext.getStore()?.sessionId;
      logger.info("profile facts evicted over memory.profile.maxEntries", {
        evicted: eviction.evicted.length,
        maxEntries: eviction.maxEntries,
        activeUnpinned: eviction.activeUnpinned,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      if (sessionId === undefined) return;
      touchRecorder(sessionId)?.recordProfileFactsEvicted({
        maxEntries: eviction.maxEntries,
        activeUnpinned: eviction.activeUnpinned,
        ids: eviction.evicted.map((fact) => fact.id),
        keys: eviction.evicted.map((fact) => fact.key),
      });
    },
  });
  const { profileStore, notesStore, embeddingClient, linkStore, lessonStore, procedureStore, voteStore } = memoryStores;
  // Rows written before their folder's constraint existed are tagged now,
  // and again when projects.constraints changes (before a turn or a
  // consolidator tick), so they stop being visible everywhere (issue #33).
  const constraintScopeBackfill = createConstraintScopeBackfill({
    db: notesStore.getDatabaseHandleForEmbeddings(),
    readConstraints: () => getConfig().projects.constraints,
    resolvePolicy: (dir) => resolveProjectConstraint(getConfig(), dir),
  });
  try {
    const result = constraintScopeBackfill.ensure();
    const tagged = result === null ? 0 : result.tagged.memories + result.tagged.lessons + result.tagged.procedures;
    if (tagged > 0) logger.info("memory rows tagged with their folder's constraint", { ...result!.tagged });
  } catch (err) {
    logger.info("memory constraint back-fill failed", { error: err instanceof Error ? err.message : String(err) });
  }
  // A later embedding model pick reattaches memory through this switch
  // instead of waiting for a restart (ATO-351). It owns the backfill
  // from here on, so shutdown stops it through the switch.
  const memoryEmbeddings = createMemoryEmbeddingSwitch({
    notesStore,
    metrics,
    logger,
    readConfig: () => getConfig(),
    initial: {
      health: memoryStores.embeddingHealth,
      modelId: memoryStores.embeddingHealth === "disabled" ? null : (config.localModels.embeddings.modelId ?? null),
      backfill: memoryStores.embeddingBackfill,
    },
  });

  const sessionStore = prepareRuntimeSessionStore(config, logger);
  // Issue #109: the fusion project's folder store (stateless; the session store reads through its own).
  const projectStore = runtimeProjectStore(config);
  // Per-folder provider constraints (issue #33): the policy of a session,
  // matched live against `projects.constraints`; see session-provider-policy.ts.
  const sessionProviderPolicy = createSessionProviderPolicy({
    readConfig: () => getConfig(),
    // A store that cannot answer (closed at shutdown) reads as no
    // session, which fails closed.
    loadSession: (id) => {
      try { return sessionStore.load(id); } catch { return null; }
    },
    // A taint the running turn holds but has not saved yet (declared below;
    // only read once the runtime runs).
    liveSession: (id) => sessionReadTaint.liveSession<SessionState>(id),
  });
  // The commands `os.shell.run` detached at the default timeout (F47).
  // One registry for the runtime, so the turn-end (`executeTurn`),
  // session-delete and shutdown paths below can stop what a session
  // left running.
  const shellJobs = new ShellJobRegistry({
    jobMaxMs: config.tools.shell.jobMaxMs,
    maxJobs: config.tools.shell.maxJobs,
  });
  // Full outputs of clipped local tool results, one temp folder per
  // session (ATO-663): removed with the session, and folders left by
  // sessions that are gone (fusion workers are never stored) swept here.
  // Each folder's marker carries the session's policy (issue #74), so
  // another session reading a spilled file is tainted with it.
  const toolOutputSpill = new ToolOutputSpill({
    policyFor: (id) => sessionProviderPolicy.effectivePolicyForSession(id),
    // A worker's orchestrators read the paths its summary hands them.
    parentsFor: (id) => fusionWorkerParents(id, (sid) => sessionReadTaint.liveSession(sid)?.metadata),
  });
  toolOutputSpill.sweepStale();
  installRuntimeSessionDelete(sessionStore, dropRecorder, shellJobs, toolOutputSpill);

  // Read taint (issue #33 group C): a read inside a constrained folder
  // narrows the session's provider policy at dispatch.
  const sessionReadTaint = createSessionReadTaint({
    readConfig: () => getConfig(),
    // The same boot config and test `registerOsTools` builds the
    // language servers from: a write taints only when they exist.
    lspWrites: config.tools.lsp?.enabled === true,
    patchStoredSession: (id, patch) => {
      const stored = sessionStore.load(id);
      if (stored === null) return;
      stored.metadata = patch(stored.metadata ?? {});
      sessionStore.save(stored);
    },
  });
  // The same constraint on another chat's transcript (sessions.*,
  // memory.sessions.search): a read taints, a search hides, a send carries.
  const crossSession = createCrossSessionPolicy({ policy: sessionProviderPolicy, readTaint: sessionReadTaint });
  // OTLP span export (ATO-496) sends prompts and answers to a collector:
  // never of an incognito chat, and off this machine only where the
  // folder allows "http" (issue #33).
  if (traces.otlpTracesUrl !== null) {
    traces.setOtlpSessionGate(createOtlpSessionGate({
      tracesUrl: traces.otlpTracesUrl,
      // A fusion worker of an incognito chat has no row of its own: while
      // any incognito chat is open, nothing is exported (fail closed).
      isIncognito: (id) => incognitoSessions.anyOpen() || sessionStore.isIncognito(id),
      policy: sessionProviderPolicy,
    }));
  }
  // Per-folder egress (issue #33): tools that would send a constrained
  // folder's content off the machine are refused at dispatch. MCP servers
  // are classed by the manager, which exists once the catalog connects.
  let egressMcp: McpManager | undefined;
  // The same guard refuses a write that would carry a constrained (or
  // read-tainted) session's content out of its folder (write-out rule).
  const egressGuard = createRuntimeDispatchGuard({
    effectivePolicyForSession: sessionProviderPolicy.effectivePolicyForSession,
    mcp: () => egressMcp,
    readConfig: () => getConfig(),
  });
  // The registry taints first (onDispatch), then checks egress against
  // the narrowed policy (effectivePolicyForSession reads the tightened frame).
  // `browser.extract` calls the model (ATO-699); the completer is built
  // further down, so the tool reads it through this ref per call.
  const browserExtract: BrowserExtractModelRef = {};
  const toolRegistry = createRuntimeToolRegistry(config, browserBackend, dangerous, toolOutputSpill, {
    onDispatch: (name, args, ctx) => { sessionReadTaint.noteDispatch(name, args, ctx); },
    dispatchGuard: egressGuard,
  }, browserExtract);

  // What the operator asked for, per session, for the turn now running
  // on it — quoted into every fusion worker's brief (`worker-prompt.ts`)
  // and read by `os.fs.write` to tell an input the request names from
  // any other file (`fs-input-guard.ts`). Set and cleared by
  // `executeTurn` around the loop; a worker's record is its brief, whose
  // ORIGINAL REQUEST block is the operator's words. Only that turn can
  // call a tool on the session (the controller runs one turn per
  // session), so a read always finds its own turn's request.
  const turnRequests = new Map<string, string>();
  // The agent's reply just before the message that started the turn (a
  // worker's: its parent's), for the same guard: a plain yes to
  // "Replace sales.csv?" replaces that file (ATO-860). Kept beside
  // `turnRequests`, set and cleared with it.
  const turnPreviousReplies = new Map<string, string>();
  // Sessions whose running turn is on a surface with no question card
  // (the desktop until ATO-1502): `ask_user` answers there at once
  // instead of raising a question nobody can answer (ATO-489). Set and
  // cleared by `executeTurn` with the two maps above.
  const turnsWithoutQuestions = new Set<string>();
  // The files a fan-out's contract declared as inputs, per worker
  // session: the worker runner declares them, `os.fs.write` refuses to
  // replace them (`fs-declared-inputs.ts`).
  const declaredInputs = new DeclaredInputsRegistry();
  const { languageServers } = registerRuntimeCoreTools({
    config, toolRegistry, dangerous, sessionStore, logger, resolveOriginalRequest: (id) => turnRequests.get(id),
    resolvePreviousReply: (id) => turnPreviousReplies.get(id),
    canAskUser: (id) => !turnsWithoutQuestions.has(id),
    declaredInputs, shellJobs, skillRegistry, profileStore, notesStore, lessonStore, procedureStore, browserBackend, crossSession,
    // os.web.fetch's bot-wall steps (browser, reader services) ask the folder's egress again (issue #33).
    webFetchEgressRefusal: (sessionId, cls) => egressRefusal(sessionProviderPolicy, sessionId, cls),
    // Only the terminal UI has an `/integrations` screen that saves an Exa
    // key into this process; every other entry point keeps the desktop /
    // `.env` advice (ATO-345).
    ...(options.analyticsSurface === "tui" ? { webSearchKeyHelp: "integrations-hub" as const } : {}),
  });

  // Vision provider wiring is deferred until after `profileManager` is
  // built so the provider can read the **current** model profile
  // through a getter instead of capturing a (potentially stale)
  // `plain-instruct` fallback at construction time. See
  // `LlamaServerProvider.capabilities` for the rationale.

  const skillCatalogState = preparedSkills.createCatalog();

  const connectedLocal = await connectRuntimeLocalProfile(config, options, logger, localProfile);
  const { profileManager, localBackend } = connectedLocal;
  const initialGrammar = connectedLocal.initialGrammar;

  const providers = await connectRuntimeProviders(config, logger, localProfile, connectedLocal);
  const { providerRegistry, resolveActiveLlmSlice, resolveCurrentRunMode, resolveActiveModelName, resolveRouteVision } = providers;
  // Issue #37: the fusion team choice of each running turn, so every
  // reader that only knows the ambient session sees its director. The
  // turn service sets and releases it; this is the one live run mode the
  // rest of the runtime reads.
  const sessionTeam = createSessionTeamChoices();
  const resolveSessionRunMode = (): ResolvedRunMode =>
    resolveCurrentRunMode(sessionTeam.get(turnContext.getStore()?.sessionId));
  builtProviderIds = () => providerRegistry.listIds();

  const bootstrapLlmSlice = resolveActiveLlmSlice();
  const textProvider = bootstrapLlmSlice.provider;
  const costAccumulator =
    config.llm?.costTracking?.enabled === true
      ? new CostAccumulator(config.llm.costTracking.dailyResetHourUtc ?? 0)
      : undefined;

  // Product analytics: token/spend totals for the turn currently in
  // flight. Unlike `costAccumulator`, which is opt-in behind
  // `costTracking.enabled`, this is always on, because `message_sent`
  // should carry the shape of a turn for every install — and it stays
  // behind the same analytics opt-out, since nothing is emitted unless
  // `captureMessageSent` fires.
  // The fusion outcome log and turn receipt: the meter feeds the
  // orchestrator's per-step usage into the open fusion turn's ledger.
  const fusionOutcomes = createRuntimeFusionOutcomes({
    stateDir: config.paths.stateDir,
    logger,
    resolveRunMode: resolveSessionRunMode,
    outcomeLogEnabled: () => resolveLlmConfig(getConfig()).runMode?.fusion?.outcomeLog !== false,
  });
  const turnUsageMeter = new TurnUsageMeter({ onRecord: fusionOutcomes.onUsageRecord });
  const fusionTurnBudget = new FusionTurnBudget();
  const fusionLiveWorkers = new FusionLiveWorkers();
  // Checkpoints of fan-outs (ATO-617), so one cut off by a restart can be
  // resumed. Files, not a table: see `run-checkpoint.ts`.
  const fusionRuns = new FusionRunStore({
    dir: join(config.paths.stateDir, FUSION_RUNS_DIR_NAME),
  });
  // What past fan-outs showed on this machine (ATO-949): one line per
  // finished worker task, summarized into the `### fusion` facts once
  // per session start. `llm.runMode.fusion.outcomeJournal: false` turns
  // both off; read live, like every run-mode setting. See `outcome-journal.ts`.
  // Separate from the fork's `fusionOutcomes` log above (`outcome-log.ts`).
  const fusionOutcomeJournal = new FusionOutcomeJournal({
    path: join(config.paths.stateDir, FUSION_OUTCOME_JOURNAL_FILE_NAME),
    enabled: () => getConfig().llm?.runMode?.fusion?.outcomeJournal !== false,
  });

  // ATO-569: what each session has spent and the account limits last
  // seen, for the composer readout. Every change goes out as a
  // session-scoped `usage_updated` event (TUI, HTTP stream frame).
  // ATO-649: today's spend over every session, persisted so it survives
  // a restart, for the readout and the `dailyLimitUsd` ceiling. Stamped
  // on the live event only when the operator asked for it.
  const dailySpend = new DailySpendStore({
    path: join(config.paths.stateDir, DAILY_SPEND_FILE_NAME),
    resetHourUtc: () => getConfig().llm?.costTracking?.dailyResetHourUtc ?? 0,
  });
  const sessionUsage = new SessionUsageLedger({
    onChange: (sessionId, usage) => {
      // Only when a configured cloud link has a known price: with none,
      // "today $0.00" could never move.
      const today = dailySpendViewFor(dailySpend, getConfig().llm?.costTracking, () =>
        hasPricedCloudLink(resolveLlmConfig(getConfig())),
      );
      emitAgentLoopEventFor(sessionId, {
        type: "usage_updated",
        sessionId,
        usage: today ? { ...usage, today } : usage,
      });
    },
  });

  const modelContext = createRuntimeModelContext(config, { ...providers, resolveCurrentRunMode: resolveSessionRunMode });
  const { resolveModelPricing, observeContextWindow, raiseContextWindowTo, resolveCatalogContextWindow, resolveCurrentVisionProvider, visionOnLiveRoute, audioOnLiveRoute } = modelContext;
  // ATO-1276: an Ollama route learns its real window (`/api/show`) now,
  // before the first turn sizes a prompt. Silent and non-blocking.
  void modelContext.primeLocalContextWindow();
  registerRuntimeVisionTools({ config, toolRegistry, resolveCurrentVisionProvider, logger });
  registerRuntimeImageTools({ toolRegistry, dangerous, getAnalytics: observability.getAnalytics, emitAgentLoopEventFor });
  registerRuntimeVideoTools({ toolRegistry, dangerous, getAnalytics: observability.getAnalytics, emitAgentLoopEventFor });
  registerRuntimeAudioTools({ toolRegistry, dangerous, emitAgentLoopEventFor });

  const mcpCatalog = await connectRuntimeMcpCatalog({
    config, options, toolRegistry, logger, dangerous, llama, initialGrammar,
    visionOnLiveRoute, audioOnLiveRoute, resolveCurrentRunMode: resolveSessionRunMode,
    ...mcpGrammarHookFor(profileManager),
    // `agent.tools.search: "auto"` reads the live route's window (ATO-558):
    // a local link's served window once `/props` has answered, else the catalogue's.
    resolveContextWindow: () => resolveActiveLlmSlice().isLlamaServer
      ? connectedLocal.getLiveProfile().contextWindow ?? resolveCatalogContextWindow()
      : resolveCatalogContextWindow(),
  });
  const { mcpManager, getGrammar, effectiveToolDescriptors } = mcpCatalog;
  egressMcp = mcpManager;

  if (config.vision.enabled) {
    logger.info("vision provider configured", {
      provider: textProvider.id,
      followsLiveRoute: true,
      autoDetect: config.vision.autoDetect,
      offeredAtBootstrap: visionOnLiveRoute(),
    });
  }

  const budgetNotices = new RequestBudgetNotices(emitAgentLoopEventFor);
  const { prepareLocalLink, llmComplete, llmCompleteStream, dailySpendLimit } = connectRuntimeFallback(options, {
    fallbackChain, resolveActiveLlmSlice, localBackend: connectedLocal.localBackend, profileManager,
    costAccumulator, turnUsageMeter, sessionUsage, dailySpend, resolveModelPricing, resolveCatalogContextWindow,
    turnBudget: fusionTurnBudget, budgetNotices,
    providerPolicy: { constraintsActive: sessionProviderPolicy.constraintsActive, policyForSession: (id) => sessionProviderPolicy.effectivePolicyForSession(id) },
    providerRegistry,
    // A session director's model on its link (issue #37).
    turnModel: (sessionId, providerId) => {
      const director = sessionTeam.get(sessionId)?.director;
      return director?.providerId === providerId ? director.model : undefined;
    },
  });
  // Smart approval (ATO-465): off unless `agent.smartApproval`, read live.
  installRiskReviewer({
    approvals, readConfig: () => getConfig(), complete: (params) => llmComplete(params),
    resolveTransport: (providerId) => resolveActiveLlmSlice(providerId).transport,
    sideCallSlotId: () => slotManager.sideCallSlotId(),
    userRequest: (sessionId) => turnRequests.get(sessionId), logger,
  });
  // Review after outside content (ATO-618): off unless `agent.taintReview`, read live.
  approvals.setTaintReview(() => getConfig().agent.taintReview);
  browserExtract.current = {
    complete: (params) => llmComplete(params),
    transport: (providerId) => resolveActiveLlmSlice(providerId).transport,
    slotId: () => slotManager.sideCallSlotId(),
    serverTemplate: () => getConfig().localModels.useServerTemplate !== "off",
  };
  const { taskStore, webhookSessionStore } = createRuntimeTaskStores({ config, logger });
  const { reflectionRunner, memoryContextProvider } = createRuntimeMemoryServices({
    config, profileStore, notesStore, linkStore, lessonStore, procedureStore, voteStore, embeddingClient,
    slotManager, llmComplete, toolTransport: bootstrapLlmSlice.transport, logger, metrics, touchRecorder, memoryHealth,
    nameGroundingSource: sessionGroundingSource(sessionStore),
  });

  const promptPreviewDeps = {
    prepareWorkspace: createWorkspaceLoader(config, logger),
    workingDir, sessionStore, profileStore, capabilities, effectiveToolDescriptors,
    getSkillCatalog: skillCatalogState.getSkillCatalog,
    getLiveProfile: connectedLocal.getLiveProfile,
    resolveModelMode: (id?: string) => resolveModelMode(
      captureModelModePolicy(resolveLlmConfig(getConfig()), resolveActiveModelName),
      id ? fallbackChain.standingOverrideFor(id) ?? undefined : undefined,
    ),
    resolveToolTransport: (id?: string) => resolveActiveLlmSlice(id ? fallbackChain.standingOverrideFor(id) ?? undefined : undefined).transport,
    resolveToolSchemaTokens: (id: string, descriptors: readonly ToolDescriptor[]) => {
      const slice = resolveActiveLlmSlice(fallbackChain.standingOverrideFor(id) ?? undefined);
      return estimateTokens(JSON.stringify(slice.adapter?.descriptorsToTools(descriptors, { strict: slice.strictTools }) ?? []));
    },
    profileWindowApplies: (id?: string) => resolveActiveLlmSlice(id ? fallbackChain.standingOverrideFor(id) ?? undefined : undefined).isLlamaServer,
    resolveCatalogContextWindow: (id?: string) => resolveCatalogContextWindow(id ? fallbackChain.standingOverrideFor(id) ?? undefined : undefined),
  };
  const compactionPromptInput = (state: SessionState) => buildRuntimePromptInput(getConfig(), promptPreviewDeps, state);
  const compactionRoute = (id: string, pin?: string) => {
    const providerId = pin ?? fallbackChain.standingOverrideFor(id) ?? providerRegistry.activeText.id;
    const slice = resolveActiveLlmSlice(providerId);
    // The entry's explicit output ceiling: a summary call's reasoning reserve stays under it.
    const outputCap = resolveLlmConfig(getConfig()).providers.find((p) => p.id === slice.provider.id)?.maxOutputTokens;
    return {
      providerId, transport: slice.transport, local: slice.isLlamaServer,
      ...(outputCap !== undefined ? { maxOutputTokens: outputCap } : {}),
      ...(slice.isLlamaServer ? { prefixReuse: connectedLocal.getLiveProfile().prefixReuse ?? "partial" } : {}),
      contextWindow: slice.isLlamaServer ? (connectedLocal.getLiveProfile().contextWindow ?? resolveCatalogContextWindow(providerId)) : resolveCatalogContextWindow(providerId),
      serverTemplate: resolveServerTemplatePolicy(getConfig().localModels, connectedLocal.getLiveProfile()).useServerTemplate,
    };
  };
  const compactionSideSlot = () => slotManager.sideCallSlotId();
  const compactionCost = (result: CompletionResult, providerId: string) => {
    const pricing = resolveModelPricing(result.modelId, providerId)?.pricing;
    return result.usage ? completionCostUsd(result.usage, pricing) : undefined;
  };
  const compaction = createContextCompaction({
    config: () => getConfig().agent.compaction,
    sessionStore, turnController, complete: llmComplete,
    promptInput: compactionPromptInput,
    route: compactionRoute,
    sideCallSlotId: compactionSideSlot,
    costOf: compactionCost,
    tokenCounter: createCompactionTokenCounter({
      config: () => getConfig(),
      route: compactionRoute,
      policyFor: (id) => sessionProviderPolicy.effectivePolicyForSession(id),
    }),
    // ATO-676: used only when `agent.compaction.memoryFlush` is on.
    memoryNotes: {
      enabled: () => getConfig().memory.notes.enabled,
      store: (note) => notesStore.store(note),
      outsideContentSources: (sessionId) => approvals.outsideContentSources(sessionId),
      // Decided by the tool, not by the result's first line: a tool that
      // frames its own text (the inbox) or is gone now counts as outside.
      isOutsideTool: (tool) => {
        if (!toolRegistry.has(tool)) return true;
        const definition = toolRegistry.get(tool);
        return definition.untrustedOutput !== undefined || definition.externalSource !== undefined;
      },
      log: (level, message, fields) => logger[level](message, fields),
    },
    background: createBackgroundCompaction({
      config: () => getConfig().agent.compaction,
      sessionStore, complete: llmComplete, promptInput: compactionPromptInput,
      route: (id) => compactionRoute(id), sideCallSlotId: compactionSideSlot, costOf: compactionCost,
      isIdle: () => turnController.busySessionIds().length === 0,
      isBusy: (id) => turnController.isBusy(id),
      log: (level, message, fields) => logger[level](message, fields),
    }),
    persist: (state, inTurn) => {
      const existed = sessionStore.load(state.id) !== null;
      sessionStore.save(state);
      // A deferred TUI session may get its first row at this checkpoint.
      if (inTurn && !existed) sessionStore.beginTurn(state.id);
    },
    warn: (sessionId, message) => logger.warn(message, { sessionId }),
    emit: (event) => {
      logCompactionOutcome(logger, event);
      if (event.type === "compaction_completed" && event.result.message) {
        logger.warn("context compaction completed with a warning", { sessionId: event.sessionId, reason: event.result.message });
      }
      emitAgentLoopEventFor(event.sessionId, event);
    },
  });

  // Who can restart the managed model after it ran out of memory
  // (ATO-334): the TUI registers itself; a headless `serve` leaves it
  // empty, because the desktop owns the model there.
  let localModelRestarter: LocalModelRestarter | null = null;

  // Plan mode. Session state, deliberately not config: it is a stance
  // for the next few turns, not a setting, and a "look but do not touch"
  // that survived a restart would be a mystery rather than a memory.
  let planMode = false;

  // What this runtime rebuilt on purpose, so the loop can label the
  // stable-prefix change that follows as expected (ATO-316).
  const prefixInvalidations = new PrefixInvalidationLedger();

  // The `skillCatalog` is a getter so that `agent-loop` reads the current
  // value on every step — `refreshSkills()` then does not require tearing
  // down the loop.
  const loopDeps = {
    projectStore,
    prepareWorkspace: promptPreviewDeps.prepareWorkspace,
    compaction: compaction.control,
    registry: toolRegistry,
    // A getter, so `runtime.setPlanMode` is observed by the next tool
    // call rather than by the next process. Same reason the approval
    // gate is the single live switch rather than a boolean copied into
    // each tool registration.
    isPlanMode: () => planMode,
    prefixInvalidations,
    // The gate itself, not a copied level: a batch of approval-gated calls
    // runs in order when nothing in it would ask (`--no-approval`), and the
    // step must see the level the operator has now, not at boot.
    approvalPosture: approvals,
    // The same live resolution the `fusion.delegate` descriptor gate
    // reads, so the tool the orchestrator is being pushed towards is
    // always in the catalog when the push happens.
    // Not when the folder's provider constraint leaves only one leg
    // (issue #33): the turn then runs as a single model.
    isFusionMode: () => {
      const runMode = resolveSessionRunMode();
      return runMode.effective === "fusion" && fusionPolicyDegradation(runMode, currentProviderPolicy()).kind === "none";
    },
    // A fusion turn starts: its fan-out grant is dropped and its $ /
    // time caps (ATO-947) start from zero.
    clearFanoutTurnGrant: (sessionId: string) => {
      approvals.fanoutScopes.clearTurnGrant(sessionId);
      // A turn that did not come through `runTurn` (sidecar, scheduler)
      // has no meter bucket; open one so the cap sees the planner's own
      // spend, measured from what it reads now.
      turnUsageMeter.ensureOpen(sessionId);
      fusionTurnBudget.begin(
        sessionId,
        turnUsageMeter.peekCostUsd(sessionId) ?? 0,
        { usd: resolveSessionRunMode().turnBudgetUsd, timeMs: resolveSessionRunMode().turnTimeBudgetMs },
      );
      fusionOutcomes.beginTurn(sessionId);
    },
    forgetDeclinedApprovals: (sessionId: string) => approvals.forgetDeclined(sessionId),
    clearUntrustedContent: (sessionId: string) => approvals.clearUntrustedContent(sessionId),
    denyPendingApprovals: (sessionId: string, reason: string) => {
      approvals.denyPendingForSession(sessionId, reason);
    },
    slotManager,
    grammar: getGrammar(),
    persistContext: (state: SessionState) => {
      const existed = sessionStore.load(state.id) !== null;
      sessionStore.save(state);
      if (!existed) sessionStore.beginTurn(state.id);
    },
    llmComplete,
    // Mid-turn steering: the loop drains this at every step boundary.
    steeringInbox,
    ...(llmCompleteStream ? { llmCompleteStream } : {}),
    toolDescriptors: effectiveToolDescriptors(),
    capabilities,
    profile,
    contextWindow: resolveCatalogContextWindow,
    // The local leg's slot count once `/props` has answered — what the
    // `### fusion` facts state for an external server.
    liveWorkerSlots: () => slotManager.observedPoolSize(),
    fusionPastRuns: (sessionId: string) => fusionOutcomeJournal.summaryLines(sessionId),
    onContextWindowObserved: observeContextWindow,
    onContextWindowExceeded: raiseContextWindowTo,
    // A refused connection to a managed local model whose process is gone
    // ends the turn at once instead of parking it (ATO-772). Read live, so
    // a mode switch or a model start between turns is seen.
    localEngineState: (providerId: string | undefined) => {
      const config = getConfig();
      return readLocalEngineState(providerId, config, resolveLlmConfig(config).activeTextProvider);
    },
    // The same reading with why, so the turn's error report says what the
    // wait decided on (ATO-1432).
    explainLocalEngineState: (providerId: string | undefined) => {
      const config = getConfig();
      return explainLocalEngineState(providerId, config, resolveLlmConfig(config).activeTextProvider);
    },
    // A managed local model that ran out of memory is restarted with a
    // smaller window instead of waited on (ATO-334). Read live, like the
    // engine state above.
    localOutOfMemory: createLocalOutOfMemoryPort({
      readConfig: () => getConfig(),
      activeTextProvider: () => resolveLlmConfig(getConfig()).activeTextProvider,
      approvals,
      restarter: () => localModelRestarter,
    }),
    // A pinned turn (`RunTurnOptions.providerId`, a fusion worker on the
    // local leg) is built for the pinned link's wire shape, not the
    // active provider's that the four getters below describe.
    contextProviderId: (sessionId: string) => fallbackChain.standingOverrideFor(sessionId) ?? undefined,
    // The task spend ceiling (ATO-1108) prices each step's completion the
    // way compaction prices its own: cache-aware, unpriced (local) = $0.
    priceCompletion: (result: CompletionResult, providerId: string | undefined) =>
      compactionCost(result, providerId ?? providerRegistry.activeText.id),
    resolveLlmSlice: (providerId: string, model?: string) => {
      const slice = resolveActiveLlmSlice(providerId);
      // A per-turn cloud model (ATO-1148) is sized and flagged as that
      // model, not the entry's default one.
      const turnModel = model !== undefined && !slice.isLlamaServer ? model : undefined;
      return {
        contextWindow: turnModel === undefined
          ? resolveCatalogContextWindow(providerId)
          : catalogWindowOf(resolveModelPricing(turnModel, providerId)),
        toolTransport: slice.transport,
        toolCallAdapter: slice.adapter,
        supportsSlotAffinity: slice.slotAffinity,
        supportsParallelTools: slice.parallelTools,
        strictTools: turnModel === undefined
          ? slice.strictTools
          : modelWantsStrictTools(resolveLlmConfig(getConfig()), providerId, turnModel),
        isLlamaServer: slice.isLlamaServer,
      };
    },
    ...(profileManager ? { profileManager } : {}),
    // Gates the two `/props` refreshes the loop owns, and carries the
    // lazy restore for a switch back to a local provider (issue #112).
    localBackend,
    ...(config.memory.profile.enabled
      ? { profileFactsProvider: () => profileStore.listForPrompt() }
      : {}),
    ...(reflectionRunner ? { reflectionRunner } : {}),
    // v2.5 (Phase B). Sliding-window reflection
    // segmentation. When `enabled`, the agent loop defers
    // reflection to every Nth turn (with a final-flush on
    // `finish`) and packs the last W user/assistant pairs into the
    // reflection prompt. Disabled by default — legacy per-reply
    // single-pair behaviour is byte-stable when the block is
    // omitted.
    ...(config.memory.reflection.segmentation.enabled &&
    reflectionRunner !== undefined
      ? {
          reflectionSegmentation: {
            enabled: true,
            triggerEveryTurns:
              config.memory.reflection.segmentation.triggerEveryTurns,
            windowTurns: config.memory.reflection.segmentation.windowTurns,
          },
        }
      : {}),
    ...(memoryContextProvider ? { memoryContextProvider } : {}),
    // Memory-v2 phase 6 — lesson lifecycle hook. Bumps
    // `success_count` / `failure_count` on every surfaced lesson at
    // the end of each turn (reply/finish → success, failed →
    // failure; cancelled/max_steps → skip). Gated on
    // `memory.lessons.enabled` since a disabled lesson surface
    // means there is nothing to bump.
    ...(config.memory.lessons.enabled
      ? {
          lessonLifecycle: createLessonLifecycleHook({
            lessonStore,
            logger,
          }),
        }
      : {}),
    // The loop has no awareness of which session it is currently driving;
    // `emitAgentLoopEvent` resolves that from the per-turn ALS frame so
    // two concurrent sessions never cross-contaminate trace records or
    // per-submission hooks, and reports terminal LLM failures to Sentry.
    // A fusion turn's receipt goes out just before its `turn_finished`.
    onEvent: fusionOutcomes.wrapEventSink(
      (event) => {
        if (event.type === "turn_finished") {
          const sessionId = turnContext.getStore()?.sessionId;
          if (sessionId !== undefined) fusionTurnBudget.end(sessionId);
        }
        emitAgentLoopEvent(event);
      },
      () => turnContext.getStore()?.sessionId,
    ),
    metrics,
    logger,
  };
  Object.defineProperty(loopDeps, "skillCatalog", {
    enumerable: true,
    get: skillCatalogState.getSkillCatalog,
  });
  // Same live binding, for the same reason: `refreshSkills()` can turn
  // a catalog that fit into one that does not, and the `### skills`
  // truncation marker has to move with it.
  Object.defineProperty(loopDeps, "skillCatalogDropped", {
    enumerable: true,
    get: skillCatalogState.getSkillCatalogDropped,
  });
  // Late-binding getters for the MCP-driven fields. `grammar` and
  // `toolDescriptors` are recomputed by `runtime.refreshMcp()` after a
  // server is live-added or live-removed via the TUI MCP panel. The
  // AgentLoop reads both on every step so the rebuilt values land on
  // the next inference without restarting the loop.
  Object.defineProperty(loopDeps, "grammar", {
    enumerable: true,
    get: getGrammar,
  });
  Object.defineProperty(loopDeps, "toolDescriptors", {
    enumerable: true,
    get: () => effectiveToolDescriptors(),
  });
  Object.defineProperty(loopDeps, "toolTransport", {
    enumerable: true,
    get: () => resolveActiveLlmSlice().transport,
  });
  Object.defineProperty(loopDeps, "toolCallAdapter", {
    enumerable: true,
    get: () => resolveActiveLlmSlice().adapter,
  });
  Object.defineProperty(loopDeps, "supportsSlotAffinity", {
    enumerable: true,
    get: () => resolveActiveLlmSlice().slotAffinity,
  });
  Object.defineProperty(loopDeps, "supportsParallelTools", {
    enumerable: true,
    get: () => resolveActiveLlmSlice().parallelTools,
  });
  Object.defineProperty(loopDeps, "strictTools", {
    enumerable: true,
    get: () => resolveActiveLlmSlice().strictTools,
  });
  const loop = new AgentLoop(
    loopDeps as typeof loopDeps & {
      skillCatalog: readonly SkillCatalogEntry[];
      grammar: string;
      toolDescriptors: readonly ToolDescriptor[];
    },
  );

  // Forward declaration: the Telegram channel is constructed after the
  // runtime body assembles (it needs a stable `runtime` reference) but
  // `shutdown` must be able to stop it before tearing down the session
  // store. The variable is bound in the `let` slot below; the closure
  // resolves it lazily so the order-of-construction concern is local.
  let telegramChannelForShutdown: TelegramChannel | null = null;
  let discordChannelForShutdown: DiscordChannel | null = null;
  let swarmForShutdown: SwarmRegistry | null = null;
  let channelsForShutdown: ChannelRegistry | null = null;
  let stopPluginMcpWatch: (() => void) | null = null;
  let approvalPendingNotifier: { dispose(): void } | null = null;
  const turnState = prepareRuntimeTurnState();
  const { pendingSessionNamings, turnsInFlight } = turnState;
  // In-flight `/enhance` passes; shutdown aborts them beside naming.
  const pendingPromptEnhances = new Set<AbortController>();
  // In-flight `/btw` side questions; shutdown aborts them the same way.
  const pendingSideQuestions = new Set<AbortController>();
  const lifecycle = createRuntimeLifecycle({
    sessionStore, logger, steeringInbox, shellJobs, reflectionRunner, pendingSessionNamings, pendingPromptEnhances, pendingSideQuestions, turnsInFlight, compaction,
    browserBackend, mcpManager, profileStore, notesStore, lessonStore, procedureStore,
    embeddingBackfill: memoryEmbeddings,
    ...(languageServers === undefined ? {} : { languageServers }),
    get scheduler() { return scheduler; },
    get taskRunner() { return taskRunner; },
    get telegramChannelForShutdown() { return telegramChannelForShutdown; },
    get discordChannelForShutdown() { return discordChannelForShutdown; },
    get swarmForShutdown() { return swarmForShutdown; },
    get channelsForShutdown() { return channelsForShutdown; },
    get pluginMcpWatch() { return stopPluginMcpWatch; },
    get approvalPendingNotifier() { return approvalPendingNotifier; },
    get consolidatorJob() { return consolidatorJob; },
    get taskStore() { return taskStore; },
    get analytics() { return observability.getAnalytics(); },
    // Ungated: shutdown flushes and closes the client even while an
    // incognito chat holds new reports.
    get errorReporter() { return observability.getShutdownErrorReporter(); },
    traceExport: { shutdown: traces.shutdownTraceExport },
  });
  const { shutdown } = lifecycle;
  const refreshSkills = notePrefixInvalidation(
    skillCatalogState.createRefreshSkills(options),
    prefixInvalidations,
    "skills refreshed",
    ["skills"],
  );

  // MCP rebuilds the tool catalog; a GitHub token save lands here too
  // (`### integrations`), and a catalog that crosses the tool-search
  // threshold rewords the persona and rules.
  const refreshMcp = notePrefixInvalidation(
    mcpCatalog.createRefreshMcp(),
    prefixInvalidations,
    "tool catalog rebuilt",
    ["system", "rules", "tools", "integrations"],
  );
  // "Stop its code" (and plugin off / removed) stops that plugin's live
  // MCP servers now, not at the next start (ATO-1407).
  stopPluginMcpWatch = mcpCatalog.watchPluginMcp(refreshMcp);

  const { reloadLlmProviders, reloadLlmProvider } = createRuntimeProviderReloads(
    logger, localProfile, connectedLocal, providerRegistry,
  );

  const { createSession, createEphemeralSession: createWorkerSession } = createRuntimeSessionFactories(workingDir, sessionStore, ensureRecorder);
  // A fusion worker's calls count on the session that spawned it, so the
  // composer's `$` readout includes what the workers spent (ATO-1388).
  const createUsageForwardingWorkerSession: typeof createWorkerSession = forwardWorkerUsage(createWorkerSession, sessionUsage);
  const previewPrompt = createRuntimePromptPreview(config, promptPreviewDeps);

  // ATO-592: `while-working` holds a sleep inhibitor while any turn runs
  // (chat, Telegram, a task); off by default.
  const keepAwake = createRuntimeKeepAwake({ config, logger });
  // The fusion project's gate (issue #39): read and decided between turns,
  // with estimates from the live team, prices, policy and limits.
  const runtimeProject = createRuntimeProject({
    loadSession: (id) => sessionStore.load(id),
    saveSession: (session) => sessionStore.save(session),
    projectStore,
    isBusy: (id) => turnController.isBusy(id),
    liveTurnElsewhere: (id) => sessionStore.liveTurnElsewhere(id),
    liveInputs: (session) => {
      const live = getConfig();
      const policy = sessionProviderPolicy.forSession(session);
      const allows = (providerId: string): boolean => policy?.allows(providerId) ?? true;
      return liveProjectInputsFrom({
        config: live,
        reachable: providers.teamMemberReachable,
        allows,
        mode: resolveCurrentRunMode(),
        currentWorker: resolveSessionWorker(session.metadata, resolveLlmConfig(live).runMode?.fusion, policy),
        currentReviewer: resolveSessionReviewer(session.metadata, resolveLlmConfig(live).runMode?.fusion, policy),
        restricted: policy !== undefined,
        tokensPerSecond: () => llama.measuredTokensPerSecond(),
        dailyRemainingUsd: dailySpendLimit.budget?.remainingUsd() ?? null,
        localSlots: slotManager.observedPoolSize(),
      });
    },
    emit: (sessionId, event) => emitAgentLoopEventFor(sessionId, { ...event, sessionId }),
  });
  const turnService = createRuntimeTurnService(config, {
    sessions: { sessionStore, turnContext, turnRequests, turnPreviousReplies, turnsWithoutQuestions },
    execution: { loop, turnController, steeringInbox, shellJobs, slotManager, llmComplete },
    inference: { providerRegistry, resolveActiveLlmSlice, resolveCurrentRunMode, resolveRouteVision, resolveActiveModelName, teamMemberReachable: providers.teamMemberReachable, fallbackChain, dailyLimitRefuses: dailySpendLimit.refuses, budgetNotices, sessionProviderPolicy, sessionReadTaint, constraintScopeBackfill, sessionTeam },
    traces, telemetry: { observability, analyticsStateStore, turnUsageMeter, sessionUsage, metrics },
    state: turnState, lifecycle, logger,
    emitEvent: emitAgentLoopEventFor,
    onProjectTurnEnd: runtimeProject.noteTurnEnd,
    projectStore,
  });
  const { steer, controlGoal } = turnService;
  const runQueuedTurn = holdWhileRunning(keepAwake, turnService.runTurn);
  const executeLockedTurn = holdWhileRunning(keepAwake, turnService.executeTurn);
  // ATO-586: an incognito chat closed mid-turn is deleted once the turn
  // has left the queue (`isBusy` is still true inside `executeTurn`).
  const incognitoSessions = createIncognitoSessions({
    sessionStore, tracesDir: config.paths.tracesDir, isBusy: (id) => turnController.isBusy(id), logger, taskStore, fusionRuns,
    // ATO-586: keep the chat's prompt out of the managed server's disk cache.
    promptCache: {
      markPrivate: () => { markPromptCachePrivate(config.paths.localModelsDataDir); },
      eraseSlots: (slotIds) => eraseManagedChatSlots(config.paths.localModelsDataDir, slotIds),
    },
    slotsOf: (id) => [slotManager.pinnedSlot(id), slotManager.reservedSideCallSlotId()]
      .filter((slot): slot is number => slot !== null && slot >= 0),
  });
  // Issue #29: no error report leaves while an incognito chat is open.
  observability.setErrorReportGate(incognitoSessions.anyOpen);
  const runTurn: typeof runQueuedTurn = (session, ...rest) => {
    incognitoSessions.noteTurn(session);
    return runQueuedTurn(session, ...rest).finally(() => incognitoSessions.settle(session.id));
  };
  const executeTurn: typeof executeLockedTurn = (session, ...rest) => {
    incognitoSessions.noteTurn(session);
    return executeLockedTurn(session, ...rest);
  };
  // ATO-586: a worker of an incognito chat is incognito too.
  const createEphemeralSession: typeof createWorkerSession = (meta, ...rest) =>
    incognitoSessions.forWorker(meta.parentSessionId, createUsageForwardingWorkerSession(meta, ...rest));

  const taskRunner = createRuntimeTaskRunner({
    config, taskStore, runTurn, sessionStore, createSession, toolRegistry,
    resolveTelegram: () => telegramChannelForShutdown, logger, metrics,
    approvalLevel: () => approvals.getLevel(),
    // A task in a constrained folder notifies its chat only with "channels" allowed (issue #33).
    notifyRefusal: (task) => channelNotifyRefusal(sessionProviderPolicy, task.sessionId),
    providerPolicy: sessionProviderPolicy,
    keepAwake,
  });
  // Cross-chat tools (ATO-570), off unless `tasks.sessionToolsEnabled`: a send is a queued task.
  registerSessionTools(toolRegistry, {
    ...dangerous, sessionStore, taskStore, taskRunner, createSession,
    defaultMaxAttempts: config.tasks.maxAttempts,
    enabled: config.tasks.enabled && config.tasks.sessionToolsEnabled === true,
    crossSession,
  });

  registerRuntimeFusionAndReadScope({
    config, toolRegistry, runTurn, createEphemeralSession, resolveOriginalRequest: (id) => turnRequests.get(id),
    declaredInputs, prepareLocalLink, emitAgentLoopEventFor, resolveCurrentRunMode: resolveSessionRunMode,
    currentWorker: () => sessionTeam.get(turnContext.getStore()?.sessionId)?.worker ?? null,
    currentReviewer: () => sessionTeam.get(turnContext.getStore()?.sessionId)?.reviewer ?? null,
    teamMemberReachable: providers.teamMemberReachable,
    resolveCurrentVisionProvider,
    providerRegistry, llama, approvals, dangerous, slotManager, workingDir, logger,
    turnBudget: fusionTurnBudget,
    sessionUsage,
    costAccumulator,
    dailySpendLimit,
    liveWorkers: fusionLiveWorkers,
    runCheckpoints: fusionRuns,
    outcomeLog: fusionOutcomes.outcomeLog,
    outcomeJournal: fusionOutcomeJournal,
    writeProjectReceipt: createProjectReceiptWriter(
      config.paths.stateDir,
      new SecretKeychain(undefined, () => {}),
      (message) => logger.warn(message),
    ),
    turnLedger: fusionOutcomes.ledger,
    steerWorker: (sessionId, text) => steeringInbox.push(sessionId, text),
    orchestratorTurnSpendUsd: (sessionId) => turnUsageMeter.peekCostUsd(sessionId),
    localFormatCheck: {
      getGrammar,
      getToolNames: () => effectiveToolDescriptors().map((d) => d.name),
      getProfile: connectedLocal.getLiveProfile,
      getModelId: connectedLocal.getLiveModelId,
    },
  });

  const mailTrigger = createRuntimeMailTrigger({
    config, taskRunner, taskStore, sessionStore, createSession, webhookSessionStore, logger,
    providerPolicy: sessionProviderPolicy,
  });
  const scheduler = createRuntimeScheduler({
    config, taskRunner, logger, metrics, resolveTelegram: () => telegramChannelForShutdown,
    ...(mailTrigger ? { sidecars: [mailTrigger] } : {}),
  });
  const consolidatorJob = createRuntimeMemoryConsolidator({
    config, notesStore, linkStore, lessonStore, procedureStore, voteStore,
    slotManager, llmComplete, logger, metrics, traceBus,
    beforeTick: () => { constraintScopeBackfill.ensure(); },
  });
  consolidatorJob?.start();
  // Weekly archive of unused agent-learned skills (ATO-580); off by default.
  void startRuntimeSkillCurator({ config, logger, cronTexts: () => recurringTaskTexts(taskStore), onArchived: refreshSkills });

  // ATO-617 / ATO-448: fusion runs a restart cut off, for `/fusion resume`
  // and for `/resume` of a cut-off orchestrator turn.
  const fusionRunsApi = {
    listResumable: (sessionId?: string) =>
      fusionRuns.listResumable(sessionId).map((run) => ({
        runId: run.runId,
        sessionId: run.sessionId,
        updatedAt: run.updatedAt,
        summary: describeResumableRun(run),
        ...resumableRunDetails(run),
      })),
    resumeMessage: (sessionId: string, runId?: string) => {
      const run =
        runId === undefined
          ? fusionRuns.listResumable(sessionId)[0]
          : fusionRuns.listResumable(sessionId).find((r) => r.runId === runId);
      return run === undefined ? null : renderResumeRequest(run);
    },
    discard: (sessionId: string, runId?: string) => {
      const run =
        runId === undefined
          ? fusionRuns.listResumable(sessionId)[0]
          : fusionRuns.listResumable(sessionId).find((r) => r.runId === runId);
      return run !== undefined && fusionRuns.discard(run.runId)
        ? run.runId
        : null;
    },
  };

  const runtime = {
    getSessionWorkspace(input: SessionState | string) {
      const session = typeof input === "string" ? sessionStore.load(input) : input;
      if (!session) throw new SessionNotFoundError(String(input));
      const mode = promptPreviewDeps.resolveModelMode(session.id);
      return mode.mode === "cloud" ? promptPreviewDeps.prepareWorkspace(session, true, undefined, { contextWindow: promptPreviewDeps.resolveCatalogContextWindow(session.id) }) : null;
    },
    config,
    loop,
    toolRegistry,
    skillRegistry,
    approvals,
    slotManager,
    sessionStore,
    turnController,
    steeringInbox,
    steer,
    fusionWorkers: {
      running: (parentSessionId: string) => fusionLiveWorkers.running(parentSessionId),
      stop: (parentSessionId: string, taskId: string) =>
        fusionLiveWorkers.stop(parentSessionId, taskId),
      escalate: (parentSessionId: string, taskId: string) =>
        fusionLiveWorkers.escalate(parentSessionId, taskId),
      steer: (parentSessionId: string, taskId: string, text: string) =>
        fusionLiveWorkers.steer(parentSessionId, taskId, text),
    },
    fusionRuns: fusionRunsApi,
    // A chat turn a restart cut off: offered, never continued on its own (ATO-448).
    interruptedTurns: createInterruptedTurns(sessionStore, fusionRunsApi),
    profileStore,
    notesStore,
    lessonStore,
    procedureStore,
    linkStore,
    voteStore,
    taskStore,
    taskRunner,
    scheduler,
    webhookSessionStore,
    telegramChannel: null,
    discordChannel: null,
    swarm: null,
    // ATO-1084: the channels are attached below; read at call time.
    teamMemberReachable: providers.teamMemberReachable,
    providerRestrictionFor: (session) => describeProviderRestriction(sessionProviderPolicy.forSession(session)),
    moveSessionFolder: (session, workingDir) => {
      const moved = moveSessionFolder(sessionProviderPolicy, session, workingDir);
      return { session: moved.session, restriction: describeProviderRestriction(moved.policy), restrictionKept: moved.kept !== undefined };
    },
    retrySessionSeed: (source, workingDir) => retrySessionSeed(sessionProviderPolicy, source, workingDir),
    sessionPolicyStamp: (sessionId) => sessionPolicyStamp(sessionProviderPolicy, (id) => sessionStore.load(id), sessionId) as Record<string, unknown> | null | undefined,
    channelSendRefusal: (session) => channelNotifyRefusal(sessionProviderPolicy, session),
    serveRefusal: (session) => egressRefusal(sessionProviderPolicy, session, "serve"),
    egressRefusal: (session, cls) => egressRefusal(sessionProviderPolicy, session, cls),
    channels: null,
    offlineMode: createOfflineModeControl({
      channels: () => ({
        registry: channelsForShutdown,
        swarm: swarmForShutdown,
      }),
      browser: () => browserBackend,
      stopDownloads: () => stopRunningDownloadWorkers(getConfig().paths.localModelsDataDir),
      warn: (message, err) =>
        logger.warn(message, {
          error: err instanceof Error ? err.message : String(err),
        }),
    }),
    mcpManager,
    providerRegistry,
    capabilities,
    toolDescriptors: effectiveToolDescriptors(),
    grammar: getGrammar(),
    logger,
    metrics,
    createSession,
    discardIncognitoSession: incognitoSessions.discard,
    createEphemeralSession,
    runTurn,
    controlGoal,
    projectState: runtimeProject.projectState,
    projectDecision: runtimeProject.projectDecision,
    projectBacklogDecision: runtimeProject.projectBacklogDecision,
    executeTurn,
    previewPrompt,
    compactSession: compaction.compactSession,
    getSessionCompaction: compaction.getSessionCompaction,
    cancelSessionCompaction: compaction.cancelSessionCompaction,
    enhancePrompt: (draft: string, enhanceOptions?: { sessionId?: string; signal?: AbortSignal }) => {
      if (lifecycle.isShutdown()) return Promise.resolve({ ok: false as const, reason: "shutting down" });
      const partition = promptEnhancePartition(enhanceOptions?.sessionId);
      return enhancePrompt(draft, {
        complete: (params) => llmComplete(params),
        slotId: () => slotManager.sideCallSlotId(),
        // Same wire-shape rule as session naming: a cloud link answers a
        // bare prompt with an empty `content`. Resolved through the
        // partition's own standing override, like compaction's route.
        toolTransport: resolveActiveLlmSlice(fallbackChain.standingOverrideFor(partition) ?? undefined).transport,
        pending: pendingPromptEnhances,
        serverTemplate: getConfig().localModels.useServerTemplate !== "off",
        ...(enhanceOptions?.sessionId ? { sessionId: enhanceOptions.sessionId } : {}),
        ...(enhanceOptions?.signal ? { signal: enhanceOptions.signal } : {}),
        onError: (err: unknown) =>
          logger.debug("prompt enhance failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
      });
    },
    askSideQuestion: (question: string, sideOptions?: { sessionId?: string; signal?: AbortSignal }) => {
      if (lifecycle.isShutdown()) return Promise.resolve({ ok: false as const, reason: "shutting down" });
      const partition = sideQuestionPartition(sideOptions?.sessionId);
      // Read once, never written back: the side question leaves no trace
      // in the session. A failed read just means no context.
      let turns: SessionState["turns"] = [];
      if (sideOptions?.sessionId) {
        try {
          turns = sessionStore.load(sideOptions.sessionId)?.turns ?? [];
        } catch {
          turns = [];
        }
      }
      return askSideQuestion(question, {
        complete: (params) => llmComplete(params),
        slotId: () => slotManager.sideCallSlotId(),
        turns,
        toolTransport: resolveActiveLlmSlice(fallbackChain.standingOverrideFor(partition) ?? undefined).transport,
        pending: pendingSideQuestions,
        serverTemplate: getConfig().localModels.useServerTemplate !== "off",
        ...(sideOptions?.sessionId ? { sessionId: sideOptions.sessionId } : {}),
        ...(sideOptions?.signal ? { signal: sideOptions.signal } : {}),
        onError: (err: unknown) =>
          logger.debug("side question failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
      });
    },
    // ATO-875: `POST /api/complete`, routed like `/enhance` above.
    completePlain: (input: PlainCompleteInput) => {
      if (lifecycle.isShutdown()) return Promise.resolve({ ok: false as const, reason: "shutting down", kind: "failed" as const });
      return completePlain(input, {
        complete: (params) => llmComplete(params),
        slotId: () => slotManager.sideCallSlotId(),
        toolTransport: resolveActiveLlmSlice(fallbackChain.standingOverrideFor(PLAIN_COMPLETE_PARTITION) ?? undefined).transport,
        pending: pendingPromptEnhances,
        serverTemplate: getConfig().localModels.useServerTemplate !== "off",
        onError: (err: unknown) =>
          logger.debug("plain completion failed", { error: err instanceof Error ? err.message : String(err) }),
      });
    },
    refreshSkills,
    refreshMcp,
    reloadLlmProviders,
    reloadLlmProvider,
    refreshLocalModelProfile: async () => {
      await profileManager?.refresh();
    },
    reconnectMemoryEmbeddings: () => memoryEmbeddings.reconnect(),
    setApprovalHandlerForSession: (sessionId, handler) =>
      approvalRouter.setForSession(sessionId, handler),
    setAnalyticsEnabled,
    reportOnboardingStep,
    reportModelConfigured,
    reportLocalEngineFailed,
    reportUiAction,
    interviewInviteIdentity,
    reportInterviewInvite,
    setLocalModelRestarter: (restarter: LocalModelRestarter | null) => {
      localModelRestarter = restarter;
    },
    getApprovalLevel: () => approvals.getLevel(),
    setApprovalLevel: (level) => approvals.setLevel(level),
    getPlanMode: () => planMode,
    setPlanMode: (on: boolean) => {
      planMode = on;
    },
    shutdown,
  } as AgentRuntime & {
    telegramChannel: TelegramChannel | null;
    discordChannel: DiscordChannel | null;
    swarm: SwarmRegistry | null;
    channels: ChannelRegistry | null;
  };
  Object.defineProperty(runtime, "skillCatalog", {
    enumerable: true,
    get: skillCatalogState.getSkillCatalog,
  });
  // Read the catalog owner on every access: refreshSkills replaces the
  // section, so the dropped count must follow its current entries.
  Object.defineProperty(runtime, "skillCatalogDropped", {
    enumerable: true,
    get: skillCatalogState.getSkillCatalogDropped,
  });
  // Same late binding as the loop's own getter: `/tools`, the sidecar
  // and every host that reads the catalog off the runtime must see the
  // fusion descriptor appear and disappear with the live run mode, not
  // with whatever the mode was when bootstrap ran.
  Object.defineProperty(runtime, "toolDescriptors", {
    enumerable: true,
    get: () => effectiveToolDescriptors(),
  });

  connectRuntimeChannels({
    runtime, config, logger, metrics, approvals, approvalRouter, options,
    connectTelegram: (channel) => { telegramChannelForShutdown = channel; },
    connectDiscord: (channel) => { discordChannelForShutdown = channel; },
    connectSwarm: (swarm) => { swarmForShutdown = swarm; },
    connectChannels: (channels) => { channelsForShutdown = channels; },
  });
  // `notifications.approvalPending`: a prompt left unanswered pings the
  // owner once, through whichever of these channels is up at that moment.
  approvalPendingNotifier = installApprovalPendingNotifier({
    approvals,
    readSettings: () => getConfig().notifications.approvalPending,
    isIncognito: (id) => sessionStore.isIncognito(id),
    anyIncognitoOpen: incognitoSessions.anyOpen,
    isChannelOwned: (id) => approvalRouter.isRouted(id),
    resolveTelegram: () => telegramChannelForShutdown,
    resolveDiscord: () => discordChannelForShutdown,
    logger,
    isRestricted: (id) => channelNotifyRefusal(sessionProviderPolicy, id) !== null,
  });

  // Deferred from the Scheduler construction site above: the first
  // due tick must not race the Telegram channel construction, so task
  // reports always find the channel object (and queue on it while it
  // is still starting).
  scheduler?.start();

  return runtime;
}
