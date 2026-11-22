import { join } from "node:path";
import type { AtomicAgentConfig } from "../../config/index.js";
import { DEFAULT_MAX_AUDIO_BYTES, getConfig, getStateSecretPaths, getTrustConfigPaths } from "../../config/index.js";
import type { CreateAgentRuntimeOptions } from "../runtime-contract.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { SessionStore } from "../../session/session-store.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import type { LlamaServerClient } from "../../llm/llama-server-client.js";
import { renewTransportPool } from "../../llm/transport-deadlines.js";
import type { ProviderRegistry } from "../../llm/provider/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import type { ResolvedRunMode, TeamMember } from "../../llm/run-mode/index.js";
import { visionCapableAlternatives } from "../../llm/provider/model-vision.js";
import { providerIdIsLlamaServer } from "../../llm/provider/registry/active-text-provider.js";
import { audioInputAllowedOn } from "../vision-route.js";
import { resolveModelPricingFor } from "../resolve-model-pricing.js";
import { createRequestBudgetScope, type RequestBudgetScope } from "../request-budget.js";
import { verifiedAdmissionPricing } from "../link-spend-billing.js";
import type { CompletionRequest } from "../../llm/provider/completion-types.js";
import type { DailySpendBudget } from "../daily-spend-budget.js";
import type { ModelProfile } from "../../llm/model-profile.js";
import type { SlotManager } from "../../llm/slot-manager.js";
import { createFusionFormatProbeFor } from "./fusion-format-check.js";
import { assertProviderAllowed, hasProjectConstraints, runWithProviderRole } from "../../llm/provider-policy.js";
import { buildFusionVisionJudge } from "./fusion-vision-judge.js";
import { readMilestoneEvidence } from "../../tools/fusion/run-criteria.js";
import type { LlmProvider } from "../../llm/index.js";
import { configuredFusionRoutingIdentity } from "./fusion-routing-identity.js";
import type { SessionUsageLedger } from "../../session/usage-meter.js";
import type { CostAccumulator } from "../../llm/provider/cost-accumulator.js";
import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";
import { ToolRegistry, type ToolRegistryOptions } from "../../tools/tool-registry.js";
import { runtimeKnownSecrets } from "../runtime-known-secrets.js";
import { FileCheckpointStore, fileCheckpointsRoot } from "../../tools/os/fs/fs-checkpoint-store.js";
import { checkpointBeforeInvoke } from "../../tools/os/fs/fs-checkpoint-targets.js";
import type { ToolOutputSpill } from "../../tools/tool-output-spill.js";
import { finishTool } from "../../tools/finish.js";
import { buildAskUserTool, replyTool } from "../../tools/conversation/index.js";
import { buildBrowserPageRenderer, buildBrowserTools, UserSiteApprovals, type BrowserExtractModelRef } from "../../tools/browser/index.js";
import type { BrowserBackend } from "../../tools/browser/browser-backend.js";
import { registerOsScreenTools, registerOsTools, type RegisteredOsTools, type DeclaredInputsRegistry, type ShellJobRegistry, type WebSearchKeyHelp } from "../../tools/os/index.js";
import { registerVerifyTools, runChecks, verifySyntax } from "../../tools/verify/index.js";
import { registerGithubTools } from "../../tools/github/index.js";
import { resolveGithubToken } from "../../github/index.js";
import { registerSkillTools, skillNameForPath, trackSkillEdits } from "../../tools/skill/index.js";
import { SkillChangeRecorder, skillCuratorPaths } from "../../skills/curator/index.js";
import { isProjectFolderTrusted } from "../../skills/project-trust.js";
import { isFusionWorkerTurn } from "./runtime-egress-guard.js";
import { hasConstrainedFolderInside } from "../../config/project-constraint-match.js";
import { buildToolViewTool } from "../../tools/tool-view/index.js";
import { planUpdateTool } from "../../tools/plan/index.js";
import { buildCanvasRenderTool } from "../../tools/canvas/index.js";
import { applyToolSearch, buildToolSearchTool, deferredToolNames, toolSearchActive } from "../../tools/tool-search/index.js";
import { buildSessionsSearchTool, registerMemoryTools, type RegisterMemoryToolsOptions } from "../../tools/memory/index.js";
import type { CrossSessionGuard } from "../../tools/sessions/index.js";
import type { EgressClass } from "../../tools/tool-egress.js";
import { sessionGroundingSource, verifyProfileNameFacts } from "../../memory/name-grounding.js";
import { registerVisionTools, type RegisterVisionToolsOptions } from "../../tools/vision/index.js";
import { IMAGE_GENERATE_TOOL, openRouterImageKey, registerImageTools } from "../../tools/image/index.js";
import { registerVideoTools, VIDEO_GENERATE_TOOL, VIDEO_RENDER_HTML_TOOL } from "../../tools/video/index.js";
import { AUDIO_TRANSCRIBE_TOOL, registerAudioListenTools, registerAudioTools } from "../../tools/audio/index.js";
import { captureImageGenerated, captureVideoGenerated } from "../../analytics/analytics-events.js";
import type { AnalyticsClient } from "../../analytics/analytics-client.js";
import { buildFusionDelegateTool, FUSION_RUNS_DIR_NAME, fusionRunShotTarget, readSlotOccupancy, teamContextFromConfig, type ContractCheckRunner, type FusionDelegateDeps } from "../../tools/fusion/index.js";
import { buildProjectTools } from "../../tools/fusion/project-tools.js";
import { buildProjectBacklogTool } from "../../tools/fusion/project-backlog-tool.js";
import { checkPlanReferences } from "../../tools/fusion/plan-references.js";
import { createPlanReview } from "../../tools/fusion/plan-reviewer.js";
import type { FusionTurnLedger } from "../../tools/fusion/turn-receipt.js";
import { parseTeamMember, teamMembers } from "../../llm/run-mode/fusion-team.js";
import { isCodexCliProvider } from "../session-director.js";
import { DEFAULT_FUSION_TEAM_PLAN_REVIEW_ROUNDS } from "../../config/llm-fusion-team-config.js";
import { liveProjectInputsFrom } from "./runtime-project.js";
import { currentPolicyAllows, currentProviderPolicy } from "../../llm/provider-policy.js";
import {
  confineReads,
  createCommandReadCheck,
  createReadTargetCheck,
  localPageCheck,
  type ConfineReadsOptions,
} from "../../tools/read-scope/index.js";
import { McpManager, buildMcpPromptGetTool, buildMcpPromptListTool, buildMcpResourceListTool, buildMcpResourceReadTool, buildMcpToolDescriptors, createMcpSamplingHandler, mergeMcpDescriptors, applyMcpToolNameRule, buildMcpToolNameRule } from "../../mcp/index.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../prompt/tool-descriptors.js";
import type { McpServerConfig } from "../../mcp/mcp-types.js";
import { loadPluginMcpServers } from "../../plugins/plugin-mcp.js";
import { createPluginMcpLiveStop } from "../../plugins/plugin-mcp-live.js";
import { listPluginSubagents } from "../../plugins/plugin-subagents.js";
import { loadAgentProfiles, normaliseProfileName, type AgentProfile } from "../../agent-profiles/index.js";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";
import { filterToolDescriptorsByConfig } from "../filter-disabled-tools.js";
import { readAtomicMailApiKey } from "../../atomic-mail/index.js";
import { resolveComposioServerConfig } from "../../composio/index.js";

// ATO-1077: the masking set lives outside composition so the chat export
// frontends (CLI, HTTP) mask the same values tool output does.
export { runtimeKnownSecrets } from "../runtime-known-secrets.js";

/**
 * The read confinement every session gets (`confineReads`), shared with
 * the browser's landed-page check (`localPageCheck`) so a page that ends
 * on a local file sees the same scope, secret files and grants.
 */
function runtimeReadConfinement(
  config: AtomicAgentConfig,
  dangerous: DangerousToolOptions,
): ConfineReadsOptions {
  return {
    grantedDirs: (sessionId) => dangerous.approvals.fanoutScopes.scopeFor(sessionId),
    readScope: () => getConfig().agent.readScope,
    approvals: dangerous,
    stateSecrets: {
      stateDir: config.paths.stateDir,
      files: getStateSecretPaths(config.paths),
    },
  };
}

/**
 * Enabled plugins' `agents/*.md` as subagent profiles, named
 * `plugin:agent`; a name that does not normalise is skipped.
 */
function pluginAgentProfiles(stateDir: string): AgentProfile[] {
  const out: AgentProfile[] = [];
  for (const p of listPluginSubagents(stateDir).profiles) {
    const [plugin, agent] = [normaliseProfileName(p.plugin), normaliseProfileName(p.name.slice(p.plugin.length + 1))];
    if (plugin === null || agent === null || p.prompt.trim().length === 0) continue;
    out.push({
      name: `${plugin}:${agent}`,
      description: p.description,
      prompt: p.prompt.trim(),
      ...(p.model === undefined ? {} : { model: p.model }),
      ...(p.tools.length === 0 ? {} : { tools: p.tools }),
      source: "plugin",
      file: p.file,
    });
  }
  return out;
}

export function createRuntimeToolRegistry(
  config: AtomicAgentConfig,
  browserBackend: BrowserBackend,
  dangerous: DangerousToolOptions,
  outputSpill?: ToolOutputSpill,
  hooks: Pick<ToolRegistryOptions, "onDispatch" | "dispatchGuard"> = {},
  /** The model `browser.extract` calls; bootstrap fills it in once the completer exists. */
  browserExtract: BrowserExtractModelRef = {},
) {
  const toolRegistry = new ToolRegistry({
    ...(outputSpill ? { outputSpill } : {}),
    // Read taint (onDispatch) narrows the session's policy, then the
    // egress guard (runtime-egress-guard.ts) refuses before hooks,
    // approval and network, against that narrowed policy (issue #33).
    ...(hooks.onDispatch ? { onDispatch: hooks.onDispatch } : {}),
    ...(hooks.dispatchGuard ? { dispatchGuard: hooks.dispatchGuard } : {}),
    knownSecrets: () => runtimeKnownSecrets(getConfig()),
    // Outside text read on a session holds its risky silent approvals
    // for the rest of the turn when `agent.taintReview` is on (ATO-618).
    onUntrustedOutput: (sessionId, source) =>
      dangerous.approvals.noteUntrustedContent(sessionId, source),
    // "Roll back here" (ATO-1056): what a file tool is about to change is
    // saved first, per session, so a chat can be taken back with its files.
    beforeInvoke: checkpointBeforeInvoke(new FileCheckpointStore(fileCheckpointsRoot(config.paths.stateDir))),
  });
  toolRegistry.register(finishTool);
  toolRegistry.register(replyTool);
  if (config.browser.enabled) {
    const domainPolicy = {
      blockedDomains: config.browser.blockedDomains,
      allowedDomains: config.browser.allowedDomains,
      userProfile: config.browser.connect === "user-chrome",
      ...(config.browser.connect === "user-chrome" ? { userSites: new UserSiteApprovals() } : {}),
      localPages: localPageCheck(runtimeReadConfinement(config, dangerous)),
    };
    for (const tool of buildBrowserTools(browserBackend, dangerous, domainPolicy, browserExtract)) {
      toolRegistry.register(tool);
    }
  }
  return toolRegistry;
}

/**
 * The `os.web.fetch` browser step (ATO-968): only the agent's own
 * browser, only when the browser tools are on, under the same domain
 * lists. The user's own Chrome is never read in the background.
 */
function webFetchRenderer(
  config: AtomicAgentConfig,
  backend: BrowserBackend | undefined,
): { webFetchRenderPage?: ReturnType<typeof buildBrowserPageRenderer> } {
  if (backend === undefined || !config.browser.enabled) return {};
  if (config.browser.connect === "user-chrome") return {};
  return {
    webFetchRenderPage: buildBrowserPageRenderer(backend, {
      blockedDomains: config.browser.blockedDomains,
      allowedDomains: config.browser.allowedDomains,
    }),
  };
}

export function registerRuntimeCoreTools(input: {
  config: AtomicAgentConfig;
  toolRegistry: ToolRegistry;
  dangerous: DangerousToolOptions;
  sessionStore: Pick<SessionStore, "listRecentWorkingDirs" | "listSummaryPage" | "listChatLines" | "searchTranscripts" | "listSearchableChatLines">
    & Partial<Pick<SessionStore, "isIncognito">>;
  logger: StructuredLogger;
  resolveOriginalRequest: (sessionId: string) => string | undefined;
  resolvePreviousReply?: (sessionId: string) => string | undefined;
  /** Whether the session's running turn can show an `ask_user` card (ATO-489). */
  canAskUser?: (sessionId: string) => boolean;
  declaredInputs: DeclaredInputsRegistry;
  shellJobs: ShellJobRegistry;
  skillRegistry: SkillRegistry;
  /** Where the user adds an Exa key, for the web-search error (ATO-345). */
  webSearchKeyHelp?: WebSearchKeyHelp;
  /** The agent's browser, for the `os.web.fetch` bot-wall step (ATO-968). */
  browserBackend?: BrowserBackend;
  /** Per-folder constraints across chats for `memory.sessions.search` (issue #33). */
  crossSession?: CrossSessionGuard;
  /** Per-folder egress for `os.web.fetch`'s ladder steps (issue #33). */
  webFetchEgressRefusal?: (sessionId: string, cls: EgressClass) => string | null;
} & Pick<RegisterMemoryToolsOptions, "profileStore" | "notesStore" | "lessonStore" | "procedureStore">): RegisteredOsTools {
  const { config, toolRegistry, dangerous, sessionStore, resolveOriginalRequest, resolvePreviousReply, declaredInputs,
    shellJobs, skillRegistry, profileStore, notesStore, lessonStore, procedureStore, logger,
    webSearchKeyHelp, canAskUser, crossSession, webFetchEgressRefusal } = input;

  const osTools = registerOsTools(toolRegistry, {
    ...dangerous,
    config: {
      http: config.http,
      web: config.web,
      projects: config.projects,
      tools: config.tools,
    },
    listRecentSessionDirs: (limit) => sessionStore.listRecentWorkingDirs(limit),
    resolveOriginalRequest: resolveOriginalRequest,
    resolvePreviousReply,
    declaredInputs,
    // The trust surface (`config.json` + `.env`) is resolved once, here,
    // and injected into the fs tools — the tools layer must not know
    // where it lives. Pinned by the level-4 `trust_config` case in
    // bootstrap.test.ts.
    trustConfigPaths: getTrustConfigPaths(config.paths),
    // Lets `os.web.search` persist its result cache and provider cooldown
    // across processes (#256); `web.search.persistCache: false` opts out.
    // Pinned by the `#256` seam case in bootstrap.test.ts — the direct
    // persistence tests cannot see this line.
    stateDir: config.paths.stateDir,
    // The closed-repository switch, read live: the Integrations hub
    // writes `git.remoteSync` and resets the config cache, so the very
    // next `git push` through the shell sees the new answer without a
    // restart. The guard never reads config itself.
    shellPolicy: {
      isGitRemoteSyncEnabled: () => getConfig().git.remoteSync,
    },
    shellJobs,
    ...(webSearchKeyHelp === undefined ? {} : { webSearchKeyHelp }),
    ...webFetchRenderer(config, input.browserBackend),
    ...(webFetchEgressRefusal === undefined ? {} : { webFetchEgressRefusal }),
    // A folder the operator trusted to run its code (a project skill
    // said yes to; an instruction file alone is not enough) starts
    // language servers without a question
    // (ATO-503). Read live, like the skill gate.
    isTrustedProject: (dir) => isProjectFolderTrusted(config.paths.userConfigFile, config.skills.projectTrust, dir),
    // A Fusion worker edits in its own worktree: a server each would be
    // N servers for one fan-out, so workers get none (ATO-503).
    skipLspSession: isFusionWorkerTurn,
    // A repository holding a constrained folder: the server would read
    // it and its errors could quote it past the read taint (issue #33).
    // Read live, like the egress guard.
    skipLspRoot: (root) => hasConstrainedFolderInside(getConfig(), root),
  });
  // Computer use (ATO-525): screenshot, click, type, key — macOS only and
  // opt-in (`tools.screen.enabled`, default off). A screenshot asks as
  // `screen_capture`, every input action as `screen_control`; the
  // descriptors follow the same gate below.
  registerOsScreenTools(toolRegistry, {
    ...dangerous,
    enabled: config.tools.screen.enabled,
    // ATO-1018: drawing marks only (and the screenshot it reads), on by default.
    point: config.tools.screen.point,
  });
  // The read-only `verify.*` family: syntax per file, and (below) a
  // command / service / page run against a throwaway copy of the
  // working directory. Registered next to the OS tools because it is
  // the review half of what they build.
  registerVerifyTools(toolRegistry, {
    ...dangerous,
    config: { browser: config.browser, tools: { verify: config.tools.verify } },
    checkCommandReads: createCommandReadCheck(runtimeReadConfinement(config, dangerous)),
    checkReadTargets: createReadTargetCheck(runtimeReadConfinement(config, dangerous)),
    resolveKnownSecrets: () => runtimeKnownSecrets(getConfig()),
    // The same guard policy as `os.shell.run`: a `git push` started by
    // verify.run obeys the remote-sync switch too (ATO-1266).
    shellPolicy: {
      isGitRemoteSyncEnabled: () => getConfig().git.remoteSync,
    },
  });
  // Always registered; each call resolves `GITHUB_TOKEN` afresh so a
  // token saved in the Integrations hub works on the next turn. The
  // descriptors, by contrast, are gated on the token (see
  // `rebuildToolDescriptorsFromMcp`) so the model never sees tools it
  // cannot exercise.
  registerGithubTools(toolRegistry, dangerous);
  // Skill scripts inherit the shell's filtered environment and its
  // passthrough list (ATO-877): one answer to "which keys reach a child".
  // Skill history (ATO-580): every `skill.view` / `skill.run_script` of a
  // user-installed skill counts as a use, and the file tools snapshot a
  // skill folder before the agent changes it and log the change after.
  const skillHistory = new SkillChangeRecorder(config.paths.globalSkillsDir, skillCuratorPaths(config.paths.stateDir));
  const reportSkillHistoryError = (err: unknown, tool: string): void => {
    logger.warn("skill history: bookkeeping failed; the tool call was not affected", {
      tool,
      error: err instanceof Error ? err.message : String(err),
    });
  };
  registerSkillTools(
    toolRegistry,
    skillRegistry,
    dangerous,
    config.tools.shell.envPassthrough,
    config.paths.stateDir,
    (record) => {
      if (record.source !== "global" || record.plugin !== undefined) return;
      const name = skillNameForPath(config.paths.globalSkillsDir, record.rootDir);
      if (name === null) return;
      void skillHistory.recordUse(name).catch((err: unknown) => reportSkillHistoryError(err, "skill usage"));
    },
  );
  trackSkillEdits(toolRegistry, { recorder: skillHistory, onError: reportSkillHistoryError });
  // `tool.view` is registered with `tool.search` in the MCP catalog phase:
  // it reads the same live descriptor list.
  // The live checklist (ATO-486): pure, always on, no approval.
  toolRegistry.register(planUpdateTool);
  // ATO-1137: a chart or HTML page saved as a new file in the working
  // folder and shown in the chat as a canvas. Always on; the write goes
  // through the fs approval funnel like `os.fs.write`.
  toolRegistry.register(buildCanvasRenderTool({
    ...dangerous,
    trustConfigPaths: getTrustConfigPaths(config.paths),
  }));
  // Clarifying questions with ready answers (ATO-489): through the
  // approval gate, so the turn waits like an approval and only the
  // person answers. Registered for the whole process, but each turn
  // offers it only where a question card is drawn (TUI, CLI, Telegram,
  // an HTTP client sending `X-Atomic-Questions`): `surfaceShowsQuestions`
  // in executeTurn. Hidden from the desktop until ATO-1502 ships its card.
  // A call from a turn where it is hidden is answered at once, no question raised.
  toolRegistry.register(buildAskUserTool({
    approvals: dangerous.approvals,
    ...(canAskUser !== undefined ? { canAsk: canAskUser } : {}),
  }));
  // Older stored names stay out of the prompt until checked against actual
  // user messages. The background walk never deletes facts or blocks boot.
  const nameGroundingSource = sessionGroundingSource(sessionStore);
  if (config.memory.profile.enabled) {
    void verifyProfileNameFacts({ store: profileStore, source: nameGroundingSource, logger })
      .catch((err: unknown) => {
        logger.warn("profile name check failed; unchecked names stay out of the prompt", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  registerMemoryTools(toolRegistry, {
    profileStore,
    profileEnabled: config.memory.profile.enabled,
    notesStore,
    notesEnabled: config.memory.notes.enabled,
    notesRecallDefaultK: config.memory.notes.recallDefaultK,
    notesHideSuperseded: config.memory.notes.reconcile,
    notesMaxContentChars: config.memory.notes.maxContentChars,
    lessonStore,
    lessonsEnabled: config.memory.lessons.enabled,
    procedureStore,
    proceduresEnabled: config.memory.procedures.enabled,
    nameGroundingSource,
    // ATO-586: an incognito chat's memory writes are refused.
    ...(sessionStore.isIncognito
      ? { isIncognitoSession: (sessionId: string) => sessionStore.isIncognito!(sessionId) }
      : {}),
  });
  // ATO-1151: search past chats word for word, then read around a hit.
  // Read-only and always on; the index is built on the first search.
  toolRegistry.register(buildSessionsSearchTool({ source: sessionStore, ...(crossSession === undefined ? {} : { crossSession }) }));
  return osTools;
}

export function registerRuntimeVisionTools(input: {
  config: AtomicAgentConfig;
  toolRegistry: ToolRegistry;
  resolveCurrentVisionProvider: RegisterVisionToolsOptions["provider"];
  logger: StructuredLogger;
}): void {
  const { config, toolRegistry, resolveCurrentVisionProvider, logger } = input;

  registerVisionTools(toolRegistry, {
    provider: config.vision.enabled ? resolveCurrentVisionProvider : undefined,
    enabled: config.vision.enabled,
    maxImagesPerCall: config.vision.maxImagesPerCall,
    maxImageBytes: config.vision.maxImageBytes,
    // A refusal names vision-capable models on the same provider, read
    // from the live config so it follows the entry being refused.
    visionAlternatives: (providerId) => {
      const entry = resolveLlmConfig(getConfig()).providers.find(
        (candidate) => candidate.id === providerId,
      );
      return entry ? visionCapableAlternatives(entry) : [];
    },
    logger,
  });
  // `audio.listen` (ATO-497, decision 62): registered unless
  // `vision.audioInput` is `false`; the descriptor gate
  // (`audioOnLiveRoute`) offers it. Unset (auto) means a local model
  // that reports audio only, so a call on a cloud link is refused
  // unless the operator set `true`. Each call also checks the model can hear.
  const audioInput = config.vision.audioInput;
  registerAudioListenTools(toolRegistry, {
    provider: resolveCurrentVisionProvider,
    enabled: audioInput !== false,
    maxAudioBytes: config.vision.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES,
    allowProvider: (provider) =>
      audioInputAllowedOn(
        providerIdIsLlamaServer(resolveLlmConfig(getConfig()), provider.id),
        audioInput,
      ),
  });
}

/**
 * `image.generate`: registered always, offered while an OpenRouter key is
 * configured (the `image` gate below). Key, data folder and analytics
 * client are read per call, so a key saved or analytics turned off
 * mid-session applies to the next picture.
 */
export function registerRuntimeImageTools(input: {
  toolRegistry: ToolRegistry;
  dangerous: DangerousToolOptions;
  getAnalytics: () => AnalyticsClient | null;
  /** Absent: no progress lines (the Core download on the first picture goes unannounced). */
  emitAgentLoopEventFor?: FusionDelegateDeps["emitEvent"];
}): void {
  const { toolRegistry, dangerous, getAnalytics, emitAgentLoopEventFor } = input;
  registerImageTools(toolRegistry, {
    ...dangerous,
    dataDir: () => getConfig().paths.localModelsDataDir,
    openRouterKey: () => openRouterImageKey(getConfig()),
    report: (event) => captureImageGenerated(getAnalytics(), event),
    ...(emitAgentLoopEventFor ? {
      onProgress: (sessionId: string, update: { fraction: number; elapsedMs: number; label: string }) => emitAgentLoopEventFor(sessionId, {
        type: "tool_progress", tool: IMAGE_GENERATE_TOOL, fraction: update.fraction, elapsedMs: update.elapsedMs, label: update.label,
      }),
    } : {}),
  });
}

/**
 * `video.generate`: registered always, offered while an OpenRouter key is
 * configured (the `video` gate below), like `image.generate`. Its
 * progress reaches the session's UIs as `tool_progress` events.
 * `video.render_html` (ATO-1164) rides along: local, free, ungated.
 */
export function registerRuntimeVideoTools(input: {
  toolRegistry: ToolRegistry;
  dangerous: DangerousToolOptions;
  getAnalytics: () => AnalyticsClient | null;
  emitAgentLoopEventFor: FusionDelegateDeps["emitEvent"];
}): void {
  const { toolRegistry, dangerous, getAnalytics, emitAgentLoopEventFor } = input;
  registerVideoTools(toolRegistry, {
    ...dangerous,
    dataDir: () => getConfig().paths.localModelsDataDir,
    openRouterKey: () => openRouterImageKey(getConfig()),
    report: (event) => captureVideoGenerated(getAnalytics(), event),
    onProgress: (sessionId, update) => emitAgentLoopEventFor(sessionId, {
      type: "tool_progress", tool: VIDEO_GENERATE_TOOL, fraction: update.fraction, elapsedMs: update.elapsedMs, label: update.label,
    }),
    // ATO-1164: HTML page to .mp4 on the local browser and ffmpeg, ungated.
    renderHtml: {
      browserConfig: () => getConfig(),
      trustConfigPaths: () => getTrustConfigPaths(getConfig().paths),
      onProgress: (sessionId, update) => emitAgentLoopEventFor(sessionId, {
        type: "tool_progress", tool: VIDEO_RENDER_HTML_TOOL, fraction: update.fraction, elapsedMs: update.elapsedMs, label: update.label,
      }),
    },
  });
}

/**
 * `audio.transcribe` (ATO-702): speech to text with whisper.cpp, always
 * on. What it lacks on first use (the speech model; on Windows and Linux
 * the whisper.cpp build) downloads into the models folder after an
 * `http` approval; the download's progress reaches the session's UIs as
 * `tool_progress` events, like `video.generate`.
 */
export function registerRuntimeAudioTools(input: {
  toolRegistry: ToolRegistry;
  dangerous: DangerousToolOptions;
  emitAgentLoopEventFor: FusionDelegateDeps["emitEvent"];
}): void {
  const { toolRegistry, dangerous, emitAgentLoopEventFor } = input;
  registerAudioTools(toolRegistry, {
    ...dangerous,
    dataDir: () => getConfig().paths.localModelsDataDir,
    onProgress: (sessionId, update) => emitAgentLoopEventFor(sessionId, {
      type: "tool_progress", tool: AUDIO_TRANSCRIBE_TOOL, fraction: update.fraction, elapsedMs: update.elapsedMs, label: update.label,
    }),
  });
}

/** What `connectRuntimeMcpCatalog` tells about the MCP grammar it applies. */
export interface McpGrammarHolder {
  setMcpToolNameRule(rule: string | null, nativeTools: boolean): void;
}

/**
 * The bootstrap seam between the MCP catalog and the hot-swap
 * `ModelProfileManager`: the agent loop reads the manager's grammar
 * before the catalog's, so without this hook the manager's grammar
 * would admit no MCP tools at all (ATO-1029). No manager, no hook.
 */
export function mcpGrammarHookFor(holder: McpGrammarHolder | null | undefined): {
  onMcpToolNameRule?: (rule: string | null, nativeTools: boolean) => void;
} {
  return holder ? { onMcpToolNameRule: (rule, nativeTools) => holder.setMcpToolNameRule(rule, nativeTools) } : {};
}

export async function connectRuntimeMcpCatalog(input: {
  config: AtomicAgentConfig;
  options: Pick<CreateAgentRuntimeOptions, "handlers">;
  toolRegistry: ToolRegistry;
  logger: StructuredLogger;
  dangerous: DangerousToolOptions;
  llama: LlamaServerClient;
  initialGrammar: string;
  visionOnLiveRoute: () => boolean;
  /** Live audio gate (`audioRouteAvailable`); absent reads as off. */
  audioOnLiveRoute?: () => boolean;
  resolveCurrentRunMode: () => ResolvedRunMode;
  /**
   * Told every MCP tool-name rule this catalog applies, so a grammar held
   * elsewhere (the hot-swap `ModelProfileManager`, which the agent loop
   * reads first) admits the same `mcp.*` names (ATO-1029); `nativeTools`
   * is whether the `mcp.resource.*` / `mcp.prompt.*` tools are registered.
   */
  onMcpToolNameRule?: (rule: string | null, nativeTools: boolean) => void;
  /**
   * The live route's context window, when known. `agent.tools.search:
   * "auto"` defers the non-core tools behind `tool.search` on a small
   * one (ATO-558). Absent ⇒ only the catalog size decides.
   */
  resolveContextWindow?: () => number | null | undefined;
}) {
  const { config, options, toolRegistry, logger, dangerous, llama, initialGrammar,
    visionOnLiveRoute, resolveCurrentRunMode, onMcpToolNameRule, resolveContextWindow } = input;
  const audioOnLiveRoute = input.audioOnLiveRoute ?? ((): boolean => false);
  let grammar = initialGrammar;

  // MCP client subsystem. The manager is always constructed so the
  // live-control surface (TUI panel, slash commands — planned) stays
  // uniform with the Telegram channel pattern. An empty
  // `config.mcp.servers[]` produces a zero-cost no-op manager.
  //
  // We start the manager **before** the descriptor filter + grammar
  // rule application so the prompt + GBNF reflect the live catalog
  // exactly. Each `McpClient` is bounded by a 15s connect timeout,
  // and failures are isolated per-server — one broken config never
  // blocks bootstrap. Catalog growth after this point (hot-add
  // server) requires `refreshMcp()` to rebuild the stable prefix /
  // grammar — see ../../mcp/docs/client.md.
  // Composio rides the same rails: when a key is configured we mint (or
  // reuse) a tool-router session and mount its hosted endpoint as one
  // more MCP server. With no key `resolveComposioServerConfig` returns
  // `undefined` and this line is the only trace of the integration —
  // no server, no tools, nothing for the model to reach for. Failure is
  // soft: an unreachable Composio must not stop the agent from booting.
  const composioServerConfig = await resolveComposioServerConfig({
    composio: config.composio,
    userConfigFile: config.paths.userConfigFile,
    logger,
  });
  // Servers from installed plugins (ATO-562) ride the same rails, named
  // `<plugin>-<server>` and always approval-gated. A broken plugin only logs.
  const ownServers = [
    ...(config.mcp?.servers ?? []),
    ...(composioServerConfig ? [composioServerConfig] : []),
  ];
  const ownServerNames = new Set(ownServers.map(s => s.name));
  const pluginMcp = safePluginMcpServers(config.paths.stateDir, ownServerNames, logger);
  const mcpServerConfigs = [...ownServers, ...pluginMcp.servers];
  const mcpEnabled = mcpServerConfigs.length > 0;
  const mcpManager = new McpManager(mcpServerConfigs, {
    toolRegistry,
    logger,
    // Same approval wiring as the native dangerous tools: servers at
    // the default `approval_gated` trust get their calls routed
    // through `requireApproval` (issue #132).
    dangerous,
    // Sampling handler is per-client; we install one for every
    // connecting server so the SDK advertises the capability. Routes
    // to LlamaServerClient with `slotId: -1` (invariant 1 in
    // `mcp-sampling-handler.ts`).
    samplingHandler: mcpEnabled
      ? createMcpSamplingHandler({
          llamaServerClient: llama,
          server: "*",
          constraintsActive: () => hasProjectConstraints(getConfig()),
        })
      : undefined,
    // ATO-704: no host wires a port yet, so servers see no elicitation
    // capability until one does (see docs/client.md).
    ...(options.handlers?.onMcpElicitation
      ? { elicitationPort: options.handlers.onMcpElicitation }
      : {}),
    // Browser sign-ins of remote servers live in `<stateDir>/mcp-oauth/`.
    oauthStateDir: config.paths.stateDir,
    ...(options.handlers?.onChannelStatus
      ? {
          onStatus: (status) =>
            options.handlers!.onChannelStatus!({
              channel: `mcp:${status.name}`,
              // The channel contract has no sign-in state; "down" with
              // "Sign in required" as the error says the same thing.
              state: status.state === "needs_auth" ? "down" : status.state,
              ...(status.lastError ? { lastError: status.lastError } : {}),
            }),
        }
      : {}),
  });
  // The four meta-tools (`mcp.resources.{list,read}` /
  // `mcp.prompts.{list,get}`) read aggregated state from `mcpManager`.
  // They are safe to register even when zero servers are connected
  // — the manager returns empty aggregates and the tools fail with a
  // structured "no server" error if invoked. Registering them
  // once when servers are present lets the live-add path (variant γ) skip a
  // first-server-only branch.
  let mcpMetaToolsRegistered = false;
  const registerMcpMetaToolsOnce = (): void => {
    if (mcpMetaToolsRegistered) return;
    toolRegistry.register(buildMcpResourceListTool(mcpManager));
    toolRegistry.register(buildMcpResourceReadTool(mcpManager));
    toolRegistry.register(buildMcpPromptListTool(mcpManager));
    toolRegistry.register(buildMcpPromptGetTool(mcpManager));
    mcpMetaToolsRegistered = true;
  };
  // Baseline grammar without MCP tool names — kept around so
  // `refreshMcp()` can rebuild from the same starting point regardless
  // of what the current MCP catalog looks like. `applyMcpToolNameRule`
  // is purely additive on top of this baseline.
  const baseGrammar = grammar;
  if (mcpEnabled) {
    await mcpManager.start();
    registerMcpMetaToolsOnce();
    const mcpToolMetas = mcpManager.listAllToolMeta();
    const rule = buildMcpToolNameRule(mcpToolMetas);
    grammar = applyMcpToolNameRule(baseGrammar, rule, mcpMetaToolsRegistered);
    onMcpToolNameRule?.(rule, mcpMetaToolsRegistered);
    logger.info("mcp: manager started", {
      configured: mcpServerConfigs.length,
      connected: mcpManager.listStatuses().filter((s) => s.state === "up")
        .length,
      tools: mcpToolMetas.length,
    });
  } else {
    // MCP off: neither the native `mcp.resource.*` / `mcp.prompt.*` tools
    // nor any per-server tool is registered, so the grammar names none.
    grammar = applyMcpToolNameRule(baseGrammar, null, false);
    onMcpToolNameRule?.(null, false);
  }

  // The descriptor stays in the prompt while the live route can see
  // (`visionRouteAvailable`) — for a local link even before the profile
  // probe lands. The descriptor blurb already says "Only available when
  // the active model + provider support multimodal input"; if the user
  // asks for image work before mmproj is loaded, the tool surfaces a
  // clear refusal naming the provider instead of silently disappearing
  // from the toolset.
  // Drop descriptors whose backing tool will not be registered at
  // runtime under the current config gates. Without this filter the
  // stable prefix advertises tools that the registry rejects on
  // first invocation — see `filter-disabled-tools.ts` for the full
  // mapping. The historical inline `vision.describe` filter is now
  // one entry in that table; behaviour for vision is unchanged.
  // Live-MCP support: every input that varies with the MCP catalog
  // (descriptor list + grammar) is rebuildable via the helper below.
  // The closure captures everything else (vision/memory/tasks gates,
  // baseline grammar, etc.) so `refreshMcp()` can re-run it after a
  // server is added or removed at runtime without touching the rest.
  const rebuildToolDescriptorsFromMcp = (): readonly ToolDescriptor[] => {
    const liveMcpEnabled = mcpManager.listServerNames().length > 0;
    const base = filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, {
      browser: { enabled: config.browser.enabled },
      web: { search: { enabled: config.web.search.enabled } },
      // Live, like the fusion gate: offered while some leg of the
      // current route can see (see `visionRouteAvailable`).
      vision: {
        enabled: config.vision.enabled,
        providerAvailable: visionOnLiveRoute(),
      },
      // Live, like vision: unset `vision.audioInput` offers it only on a
      // local model that reports audio (decision 62).
      audio: { enabled: audioOnLiveRoute() },
      memory: {
        profile: { enabled: config.memory.profile.enabled },
        notes: { enabled: config.memory.notes.enabled },
        lessons: { enabled: config.memory.lessons.enabled },
        procedures: { enabled: config.memory.procedures.enabled },
      },
      tasks: {
        agentToolsEnabled:
          config.tasks.enabled && config.tasks.agentToolsEnabled,
      },
      sessions: {
        agentToolsEnabled:
          config.tasks.enabled && config.tasks.sessionToolsEnabled === true,
      },
      email: {
        available:
          readAtomicMailApiKey() !== null && config.atomicMail.address !== null,
      },
      mcp: { enabled: liveMcpEnabled },
      // Read at rebuild time, not boot time: the Integrations hub calls
      // `refreshMcp()` after a token save, which lands here.
      github: { connected: resolveGithubToken() !== null },
      // The fan-out descriptor (and the `### fusion` guidance block that
      // keys off it) only exists while the resolver says fusion — an
      // orchestrator that cannot delegate must not be told it can.
      fusion: { enabled: resolveCurrentRunMode().effective === "fusion" },
      image: { available: openRouterImageKey(getConfig()) !== undefined },
      // Same key, same reason: every clip is made on OpenRouter.
      video: { available: openRouterImageKey(getConfig()) !== undefined },
      // Boot-time, like the registration above: the tools exist only when
      // they were switched on before start and the host is a Mac.
      screen: {
        enabled: config.tools.screen.enabled && process.platform === "darwin",
        point: config.tools.screen.point && process.platform === "darwin",
      },
    });
    if (!liveMcpEnabled) return base;
    return mergeMcpDescriptors(
      base,
      buildMcpToolDescriptors(mcpManager.listAllToolMeta()),
    );
  };
  /**
   * The descriptor list the loop reads, with a LIVE fusion gate.
   *
   * The gate cannot be a boot snapshot. `resolveCurrentRunMode()`
   * changes answer the moment the operator switches the active provider
   * or the stored mode — Manage → LLM writes the config file and resets
   * the config cache in the same breath — and a list frozen at boot left
   * the whole mode inert: an operator who started on local or cloud and
   * switched into fusion got the mode's chrome, no `fusion.delegate`
   * descriptor and no `### fusion` guidance, so the orchestrator never
   * reached for the tool and fusion silently did nothing until a
   * restart.
   *
   * Rebuilding is not free (it filters the whole catalog and re-merges
   * the MCP descriptors), so the array is memoised on the gate: while
   * the gate holds, every read returns the *same array identity* and the
   * stable prefix stays byte-identical. When the gate flips the prefix
   * legitimately changes once and that session's KV cache is dropped —
   * exactly what installing a skill or live-adding an MCP server
   * (`refreshMcp`) already costs, and for the same reason: the tool
   * catalog changed, so the prefix must.
   */
  //
  // The vision gate is memoised the same way and for the same reason:
  // switching to a provider that cannot see drops `vision.describe`
  // from the prompt, switching back restores it — one prefix change per
  // flip, none while the route holds. The image gate too: saving or
  // removing an OpenRouter key adds or drops `image.generate` and
  // `video.generate` (one gate value: they share the key).
  //
  // Tool search (ATO-558) is one more gate: when `agent.tools.search`
  // (live config) and the route's window or the catalog size say so,
  // the prompt describes only the core tools in full and lists the rest
  // as one-liners behind `tool.search`. `fullToolDescriptors` keeps the
  // undeferred list — what `tool.search` searches and loads from.
  let fullToolDescriptors = rebuildToolDescriptorsFromMcp();
  const toolSearchOn = (): boolean =>
    toolSearchActive(
      getConfig().agent.tools?.search ?? "auto",
      fullToolDescriptors.length,
      resolveContextWindow?.(),
    );
  const liveDescriptorGates = (): string =>
    `${resolveCurrentRunMode().effective === "fusion"}|${visionOnLiveRoute()}|${audioOnLiveRoute()}|${openRouterImageKey(getConfig()) !== undefined}|${toolSearchOn()}`;
  let cachedDescriptorGates = liveDescriptorGates();
  let cachedToolDescriptors = applyToolSearch(fullToolDescriptors, toolSearchOn());
  const rebuildToolDescriptors = (): readonly ToolDescriptor[] => {
    fullToolDescriptors = rebuildToolDescriptorsFromMcp();
    cachedDescriptorGates = liveDescriptorGates();
    cachedToolDescriptors = applyToolSearch(fullToolDescriptors, toolSearchOn());
    return cachedToolDescriptors;
  };
  const effectiveToolDescriptors = (): readonly ToolDescriptor[] =>
    liveDescriptorGates() === cachedDescriptorGates
      ? cachedToolDescriptors
      : rebuildToolDescriptors();
  // Registered whatever the mode: its descriptor is only in the prompt
  // while search mode is on, and a call outside it still searches the
  // full catalog harmlessly.
  const toolSearchCatalog = () => {
    const effective = effectiveToolDescriptors();
    return {
      descriptors: fullToolDescriptors,
      deferred: deferredToolNames(fullToolDescriptors, effective),
    };
  };
  toolRegistry.register(buildToolSearchTool({ catalog: toolSearchCatalog }));
  // `tool.view` loads by exact name any tool search mode deferred to a
  // `# extras` one-liner, including the statically frequent ones
  // (`os.git.status`) and MCP tools the static catalog does not hold.
  toolRegistry.register(buildToolViewTool({ deferred: toolSearchCatalog }));
  const createRefreshMcp = () => {


    /**
     * Rebuild the GBNF grammar and the prompt's `### tools` catalog from
     * the live `mcpManager` state. Called by the TUI MCP orchestrator
     * after `addServerLive` / `removeServerLive`. Idempotent — safe to
     * call when nothing changed (just re-runs the same builders).
     *
     * If MCP has just transitioned from "no servers" to "≥1 server", we
     * register the four MCP meta-tools on demand (they were skipped at
     * bootstrap to keep the descriptor catalog clean).
     */
    const refreshMcp = async (): Promise<void> => {
      const serverCount = mcpManager.listServerNames().length;
      if (serverCount > 0) {
        registerMcpMetaToolsOnce();
      }
      const metas = mcpManager.listAllToolMeta();
      const rule = buildMcpToolNameRule(metas);
      grammar = applyMcpToolNameRule(baseGrammar, rule, mcpMetaToolsRegistered);
      onMcpToolNameRule?.(rule, mcpMetaToolsRegistered);
      rebuildToolDescriptors();
      logger.info("mcp: catalog refreshed", {
        servers: serverCount,
        tools: metas.length,
      });
    };
    return refreshMcp;
  };
  /**
   * Stop a plugin's running MCP servers the moment its state no longer
   * allows them (code stopped, plugin or server off, plugin removed;
   * ATO-1407), from this process or another (the CLI the desktop runs).
   * Returns the unwatch; a no-op when no plugin server was started.
   */
  const watchPluginMcp = (refreshMcp: () => Promise<void>): (() => void) => {
    if (pluginMcp.servers.length === 0) return () => {};
    return createPluginMcpLiveStop({
      stateDir: config.paths.stateDir,
      manager: mcpManager,
      started: pluginMcp.servers,
      owners: pluginMcp.owners,
      takenNames: ownServerNames,
      refresh: refreshMcp,
      logger,
    }).watch();
  };
  return { mcpManager, getGrammar: () => grammar, effectiveToolDescriptors, createRefreshMcp, watchPluginMcp };
}

export function registerRuntimeFusionAndReadScope(input: {
  config: AtomicAgentConfig;
  toolRegistry: ToolRegistry;
  runTurn: FusionDelegateDeps["runTurn"];
  createEphemeralSession: FusionDelegateDeps["createEphemeralSession"];
  resolveOriginalRequest: (sessionId: string) => string | undefined;
  declaredInputs: DeclaredInputsRegistry;
  prepareLocalLink: FusionDelegateDeps["warmWorkerBackend"];
  emitAgentLoopEventFor: FusionDelegateDeps["emitEvent"];
  resolveCurrentRunMode: FusionDelegateDeps["resolveRunMode"];
  /** The calling session's preferred worker (issue #37); see `FusionDelegateDeps.currentWorker`. */
  currentWorker?: FusionDelegateDeps["currentWorker"];
  /** The calling session's reviewer (issue #71); see `FusionDelegateDeps.currentReviewer`. */
  currentReviewer?: FusionDelegateDeps["currentReviewer"];
  /** Whether a team member can answer now (issue #37); `connectRuntimeProviders().teamMemberReachable`. */
  teamMemberReachable?: (member: TeamMember) => boolean;
  /** The provider `vision.describe` routes to now: the fusion vision judge's last fallback (issue #40). */
  resolveCurrentVisionProvider?: (providerId: string | undefined) => LlmProvider | undefined;
  providerRegistry: Pick<ProviderRegistry, "getProvider"> & Partial<Pick<ProviderRegistry, "getLoadedEntrySnapshot" | "modelVariant">>;
  llama: Pick<
    LlamaServerClient,
    "measuredTokensPerSecond" | "fetchSlots" | "probeHealth"
  >;
  approvals: ApprovalGate;
  dangerous: DangerousToolOptions;
  slotManager: FusionDelegateDeps["slotManager"] &
    Partial<Pick<SlotManager, "getSlotCount" | "reservedSideCallSlotId">>;
  workingDir: string;
  logger: StructuredLogger;
  turnBudget?: FusionDelegateDeps["turnBudget"];
  /** The composer's `$` readout: escalation and judge calls land here (ATO-1388). */
  sessionUsage?: Pick<SessionUsageLedger, "record">;
  /** `llm.costTracking`'s session and day totals: escalation and judge calls count here too (ATO-1497). */
  costAccumulator?: Pick<CostAccumulator, "recordTurn">;
  /**
   * Today's spend ceiling (ATO-649), for escalation and judge calls, which
   * go straight to the provider past the fallback seam: `enforce` is the
   * seam's early refusal, `budget` the daily ledger their request scope
   * holds and settles on. The seam never sees these calls, so nothing
   * counts them twice.
   */
  dailySpendLimit?: { enforce(providerId: string): void; budget: DailySpendBudget | undefined;
    observeScope?(providerId: string, request: CompletionRequest, scope: RequestBudgetScope | undefined): RequestBudgetScope | undefined;
  };
  liveWorkers?: FusionDelegateDeps["liveWorkers"];
  steerWorker?: FusionDelegateDeps["steerWorker"];
  orchestratorTurnSpendUsd?: FusionDelegateDeps["orchestratorTurnSpendUsd"];
  runCheckpoints?: FusionDelegateDeps["runCheckpoints"];
  outcomeLog?: FusionDelegateDeps["outcomeLog"];
  /** Upstream's past-runs journal (ATO-949, `outcome-journal.ts`). */
  outcomeJournal?: FusionDelegateDeps["outcomeJournal"];
  writeProjectReceipt?: FusionDelegateDeps["writeProjectReceipt"];
  receiptProjectFolder?: FusionDelegateDeps["receiptProjectFolder"];
  /** The fan-outs' receipts and the plan reviews' spend (issue #118). */
  turnLedger?: Pick<FusionTurnLedger, "noteFanout" | "notePlanReview">;
  /**
   * What the local legs' format check sends with (`fusion-format-check.ts`):
   * the step's live base grammar and tool names, and the main local
   * server's live profile and model id. Absent, no leg is checked.
   */
  localFormatCheck?: {
    getGrammar: () => string;
    getToolNames: () => readonly string[];
    getProfile: () => ModelProfile;
    getModelId: () => string | null;
  };
}): void {
  const { config, toolRegistry, runTurn, createEphemeralSession, resolveOriginalRequest, declaredInputs,
    prepareLocalLink, emitAgentLoopEventFor, resolveCurrentRunMode, providerRegistry,
    llama, approvals, dangerous, slotManager, workingDir, logger, turnBudget,
    orchestratorTurnSpendUsd, liveWorkers, steerWorker, runCheckpoints, sessionUsage,
    outcomeLog, outcomeJournal, turnLedger, localFormatCheck, costAccumulator, dailySpendLimit, currentWorker, currentReviewer, teamMemberReachable } = input;


  // The orchestrator's fan-out. Registered UNCONDITIONALLY: the tool
  // re-reads `resolveRunMode()` on every call and refuses when fusion is
  // not effective, which is the correct and only gate it needs. A boot
  // gate here was worse than redundant — it made the tool unreachable
  // for the rest of the process to anyone who switched into fusion
  // mid-session, so the mode ran with its chip, its tint and its config
  // and no way to delegate. What the model is *told* about still tracks
  // the live mode: `effectiveToolDescriptors()` adds and drops the
  // descriptor (and with it the `### fusion` guidance) as the resolver's
  // answer changes.
  // Escalation (ATO-942), the reviewers and the plan reviewer (issue
  // #118): one completion pinned to the provider asked, never the
  // fallback chain, the folder's constraint checked before anything is sent.
  const escalationComplete: NonNullable<FusionDelegateDeps["escalationComplete"]> = async ({ providerId, model, prompt, maxOutputTokens, signal, sessionId }) => {
    const base = providerRegistry.getProvider(providerId);
    if (base === undefined) {
      throw new Error(`escalation provider ${providerId} is not configured`);
    }
    // A fusion team reviewer's own model (issue #37): the provider's
    // copy built for it, which keeps the provider id the folder's
    // constraint below is checked against.
    const provider = model === undefined ? base : await providerRegistry.modelVariant?.(providerId, model);
    if (provider === undefined) {
      throw new Error(`cannot ask llm provider "${providerId}" for model "${model}"`);
    }
    // The folder's provider constraint (issue #33), on the provider
    // actually returned, before the spend ceiling and anything sent.
    assertProviderAllowed(provider.id ?? providerId, { constraintsActive: () => hasProjectConstraints(getConfig()) });
    const request = {
      prompt,
      maxOutputTokens,
      signal,
    };
    // The daily ceiling refuses a paid link before anything is sent,
    // as the fallback seam does for every other call (ATO-649).
    dailySpendLimit?.enforce(providerId);
    const dailyBudget = dailySpendLimit?.budget;
    const turnLimited = sessionId !== undefined && turnBudget?.requestLimits(sessionId) !== undefined;
    const resolvedForBudget = turnLimited || dailyBudget !== undefined ? resolveLlmConfig(getConfig()) : undefined;
    const entryForBudget = resolvedForBudget?.providers.find(p => p.id === providerId);
    const baseScope = resolvedForBudget === undefined ? undefined : createRequestBudgetScope(turnLimited ? turnBudget : undefined, { ...request, sessionId }, provider, entryForBudget,
      resolveModelPricingFor(resolvedForBudget, provider.chatModelId ?? entryForBudget?.defaultChatModel ?? entryForBudget?.model ?? null, providerId),
      dailyBudget);
    const scope = dailySpendLimit?.observeScope?.(providerId, { ...request, sessionId }, baseScope) ?? baseScope;
    let result: Awaited<ReturnType<typeof provider.complete>> | undefined;
    try {
      result = await provider.complete({ ...request, ...(scope === undefined ? {} : { requestBudget: scope, signal: scope.signal ?? signal }) });
    } finally {
      scope?.finish(result);
    }
    // These calls go straight to the provider, past the seam that
    // feeds the session's readout, so they are counted here on the
    // session that delegated (ATO-1388). Priced like any other call:
    // no known price stays "unpriced", a local server stays local.
    if (sessionUsage !== undefined && sessionId !== undefined) {
      try {
        const resolved = resolveLlmConfig(getConfig());
        const entry = resolved.providers.find((p) => p.id === providerId);
        const model = resolveModelPricingFor(resolved, result.modelId, providerId);
        sessionUsage.record(sessionId, {
          providerId,
          modelId: result.modelId,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
          ...(model === undefined ? {} : { model }),
          local:
            entry !== undefined &&
            (entry.kind === "llama-server" || isLocalServerUrl(entry.baseUrl ?? entry.url)),
          plan: entry?.kind === "subscription-cli",
        });
      } catch {
        // The readout never takes an escalation down.
      }
    }
    // The same call in `llm.costTracking`'s session and day totals
    // (ATO-1497), gated like the fallback seam's: any call with usage,
    // no session needed.
    if (costAccumulator !== undefined && result.usage !== undefined) {
      try {
        const model = resolveModelPricingFor(resolveLlmConfig(getConfig()), result.modelId, providerId);
        costAccumulator.recordTurn({
          modelId: result.modelId,
          usage: result.usage,
          ...(model === undefined ? {} : { model }),
        });
      } catch {
        // Cost tracking never takes an escalation down.
      }
    }
    // The model that effectively answered (issue #98). A subscription
    // CLI echoes its configured model when it reports none: only one
    // that differs from what it was asked for counts as reported.
    const reportedModel = (() => {
      const id = result.modelId ?? undefined;
      if (id === undefined || id.length === 0) return undefined;
      const entry = resolveLlmConfig(getConfig()).providers.find((p) => p.id === providerId);
      if (entry?.kind !== "subscription-cli") return id;
      const asked = model ?? provider.chatModelId ?? entry.defaultChatModel ?? entry.model;
      return id === asked || id === "default" ? undefined : id;
    })();
    return {
      content: result.content,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(reportedModel === undefined ? {} : { model: reportedModel }),
    };
  };

  toolRegistry.register(
    buildFusionDelegateTool({
      runTurn: (session, userMessage, turnOptions) =>
        runTurn(session, userMessage, turnOptions),
      createEphemeralSession,
      resolveOriginalRequest: resolveOriginalRequest,
      resolveRoutingIdentity: (providerId) => {
        const live = getConfig();
        const entry = resolveLlmConfig(live).providers.find((provider) => provider.id === providerId);
        const loaded = providerRegistry.getLoadedEntrySnapshot?.(providerId);
        if (loaded === undefined) return undefined;
        if (loaded.kind === "llama-server") {
          const provider = providerRegistry.getProvider(providerId);
          // entry.url is vision-only: read the loaded text client's real base.
          if (entry?.kind !== loaded.kind || provider?.textRequestBaseUrl === undefined) return undefined;
          return configuredFusionRoutingIdentity({ ...loaded, url: provider.textRequestBaseUrl }, {
            mode: live.localModels.mode, url: live.localModels.url,
            configuredModelId: live.localModels.managed.modelId, liveModelId: provider.chatModelId ?? null,
          });
        }
        const loadedIdentity = configuredFusionRoutingIdentity(loaded);
        return loadedIdentity !== undefined && loadedIdentity === configuredFusionRoutingIdentity(entry)
          ? loadedIdentity : undefined;
      },
      declaredInputs,
      // The Codex CLI confines its own shell (`-s read-only`) rather than
      // turning it off, so it is no `model: "orchestrator"` target.
      cliToolsStayOn: (providerId) => {
        const entry = resolveLlmConfig(getConfig()).providers.find((p) => p.id === providerId);
        return entry?.kind === "subscription-cli" && entry.subscriptionCli?.cli === "codex";
      },
      // The worker leg's pricing, when the catalogue or a hand-priced
      // entry knows it — the status table's spend line.
      resolveWorkerPricing: (providerId, modelId) =>
        resolveModelPricingFor(
          resolveLlmConfig(getConfig()),
          modelId,
          providerId,
        )?.pricing,
      // The same minus snapshot-only prices: only verified pricing may
      // refuse an escalation by its worst case or enable its re-run.
      resolveWorkerAdmissionPricing: (providerId, modelId) =>
        verifiedAdmissionPricing(resolveModelPricingFor(
          resolveLlmConfig(getConfig()),
          modelId,
          providerId,
        )),
      // The same client the llama-server provider serves workers with,
      // so the speed a worker's time limit is sized from is the speed
      // its own completions run at.
      localTokensPerSecond: () => llama.measuredTokensPerSecond(),
      // A local worker sent after one was cut off, on a server that still
      // answers, goes out on fresh connections (ATO-1357).
      renewLocalTransport: () => renewTransportPool(),
      probeSlotOccupancy: async () => {
        try {
          return readSlotOccupancy(await llama.fetchSlots());
        } catch {
          return null;
        }
      },
      // Asked before a local worker is sent after one was cut off
      // (ATO-917): a server that stopped answering fails the task now.
      probeLocalHealth: () => llama.probeHealth(),
      // Per local server (ATO-1318): this client only ever asks the main
      // local server (`localModels.url`), so it is the probe for a leg on
      // that server alone. A second local server has no probe here and
      // its leg is not checked, rather than checked against the wrong one.
      probeLocalHealthFor: (providerId) => {
        const entry = resolveLlmConfig(getConfig()).providers.find((p) => p.id === providerId);
        if (entry === undefined || entry.kind !== "llama-server") return undefined;
        const main = getConfig().localModels.url;
        const same = (a: string, b: string): boolean =>
          a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
        return entry.url === undefined || same(entry.url, main)
          ? () => llama.probeHealth()
          : undefined;
      },
      // One short completion under the workers' grammar before the first
      // fan-out on the main local server's leg; never a cloud leg.
      ...(localFormatCheck === undefined
        ? {}
        : {
            localGrammarProbeFor: createFusionFormatProbeFor({
              getConfig,
              providers: () => resolveLlmConfig(getConfig()).providers,
              complete: async (providerId, request) => {
                const provider = providerRegistry.getProvider(providerId);
                if (provider === undefined) {
                  throw new Error(`format check: provider ${providerId} is not configured`);
                }
                // The worker leg must be one the folder allows (issue #33).
                return runWithProviderRole("the fusion format check", async () => {
                  assertProviderAllowed(provider.id ?? providerId, { constraintsActive: () => hasProjectConstraints(getConfig()) });
                  return provider.complete(request);
                });
              },
              slotOccupancy: async () => {
                try {
                  return readSlotOccupancy(await llama.fetchSlots());
                } catch {
                  return null;
                }
              },
              // The reflection/compaction slot when reserved; never reserves one.
              sideCallSlotId: () => slotManager.reservedSideCallSlotId?.() ?? null,
              slotCount: () => slotManager.getSlotCount?.() ?? slotManager.poolSize(),
              ...localFormatCheck,
            }),
          }),
      // The turn's $ / time caps (ATO-947), reset at each fusion turn's
      // start by the loop; read only when a cap is configured.
      ...(turnBudget === undefined ? {} : { turnBudget }),
      ...(turnBudget === undefined ? {} : { workerBudget: turnBudget, requestBudgetAccounting: true }),
      ...(orchestratorTurnSpendUsd === undefined
        ? {}
        : { orchestratorTurnSpendUsd }),
      // Escalation (ATO-942): one completion pinned to the configured
      // escalation provider — never the fallback chain, so it cannot
      // land on a model the operator did not pick for it.
      escalationComplete,
      // In the order the completion seam asks for a model: the provider's own first.
      resolveDefaultModel: (providerId: string) => {
        const entry = resolveLlmConfig(getConfig()).providers.find((p) => p.id === providerId);
        const id = providerRegistry.getProvider(providerId)?.chatModelId ?? entry?.defaultChatModel ?? entry?.model;
        return typeof id === "string" && id.length > 0 && id !== "default" ? id : undefined;
      },
      ...(liveWorkers === undefined ? {} : { liveWorkers }),
      ...(steerWorker === undefined ? {} : { steerWorker }),
      // Run checkpoints (ATO-617): a fan-out cut off by a restart can be
      // resumed from its unfinished wave.
      ...(runCheckpoints === undefined ? {} : { runCheckpoints }),
      // The outcome log and the turn receipt's tally (counts only).
      ...(outcomeLog === undefined ? {} : { outcomeLog }),
      ...(outcomeJournal === undefined ? {} : { outcomeJournal }),
      writeProjectReceipt: input.writeProjectReceipt,
      receiptProjectFolder: input.receiptProjectFolder,
      ...(turnLedger === undefined ? {} : { turnLedger }),
      approvals,
      approvalRequired: dangerous.approvalRequired,
      slotManager,
      resolveRunMode: resolveCurrentRunMode,
      // The session's director and preferred worker (issue #37), read
      // from the ambient turn per call.
      ...(teamMemberReachable === undefined
        ? {}
        : { resolveFusionTeam: () => teamContextFromConfig(getConfig(), teamMemberReachable) }),
      ...(currentWorker === undefined ? {} : { currentWorker }),
      ...(currentReviewer === undefined ? {} : { currentReviewer }),
      workerSupportsSlotAffinity: (providerId) =>
        providerRegistry.getProvider(providerId)?.capabilities
          .supportsSlotAffinity ?? false,
      warmWorkerBackend: prepareLocalLink,
      // The PARENT's id, explicitly: the hook these fire from runs
      // under the worker's ALS frame, where the ambient session is a
      // throwaway nobody is listening to.
      emitEvent: emitAgentLoopEventFor,
      workingDir,
      // Fan-outs never write in the agent's own state directory (ATO-1267).
      agentStateDir: config.paths.stateDir,
      // Subagent profiles a task may name (ATO-566), read per fan-out so a
      // new file or a trust answer applies without a restart. Project
      // files load only once the folder trusted them.
      resolveAgentProfiles: (dir) =>
        loadAgentProfiles({
          workingDir: dir,
          stateDir: config.paths.stateDir,
          configFile: config.paths.userConfigFile,
          startupTrust: config.skills.projectTrust,
          pluginProfiles: () => pluginAgentProfiles(config.paths.stateDir),
        }),
      outputCharCap: config.agent.batchToolResultCharCap,
      // A contract's declared `checks` run through the verify family,
      // each on a throwaway copy of the workspace, so a fan-out is judged
      // by what its output does, never by what a worker's reply says.
      runChecks: Object.assign((specs: Parameters<ContractCheckRunner>[0], ctx: Parameters<ContractCheckRunner>[1]) =>
        runChecks(specs, {
          workingDir: ctx.workingDir,
          signal: ctx.signal,
          config,
          // A fusion run's page-check screenshots are kept with the run,
          // under `<stateDir>/fusion-runs/<runId>/shots` (issue #40).
          ...(ctx.run === undefined ? {} : {
            screenshotTargetFor: (index: number) => fusionRunShotTarget(join(config.paths.stateDir, FUSION_RUNS_DIR_NAME), ctx.run!, ctx.checkTasks?.[index]),
          }),
          shellPolicy: { isGitRemoteSyncEnabled: () => getConfig().git.remoteSync },
          ...(ctx.inputIntegrity === undefined ? {} : { inputIntegrity: ctx.inputIntegrity }),
          ...(ctx.changedPaths === undefined ? {} : { changedPaths: ctx.changedPaths }),
          ...(specs.some(spec => spec.kind === "files" || spec.kind === "research") ? { knownSecrets: runtimeKnownSecrets(getConfig()) } : {}),
        }), { supportsInputIntegrity: true as const }),
      shellPolicy: { isGitRemoteSyncEnabled: () => getConfig().git.remoteSync },
      // The same dispatch guard as a verify.run call of the delegating
      // session: a check the folder's egress rule refuses never runs.
      contractCheckEgress: (spec, ctx) => spec.kind === "research" && spec.network === true
        ? toolRegistry.dispatchRefusal("os.http.request", {}, ctx)
        : toolRegistry.dispatchRefusal("verify.run", spec, ctx),
      // Visual contract checks judged by a vision-capable team member
      // (issue #40); off with `vision.enabled: false`, when every visual
      // criterion stays unverified.
      ...(!config.vision.enabled ? {} : {
        visionJudge: buildFusionVisionJudge({
          providerRegistry,
          providerEntries: () => resolveLlmConfig(getConfig()).providers,
          routeProvider: () => input.resolveCurrentVisionProvider?.(undefined),
          assertAllowed: (id) => assertProviderAllowed(id, { constraintsActive: () => hasProjectConstraints(getConfig()) }),
        }),
      }),
      checkCommandReads: createCommandReadCheck(runtimeReadConfinement(config, dangerous)),
      checkReadTargets: createReadTargetCheck(runtimeReadConfinement(config, dangerous)),
      // `verify.syntax`'s own checker: the delegate syntax-checks every
      // green row's changed files itself, so the orchestrator does not
      // spend a step (and its context) on it after each fan-out.
      syntaxCheck: (files, dir, options) => verifySyntax(files, dir, options),
      // Check output reaches workers outside the registry: masked with
      // the same keys the registry masks tool results with (ATO-1077).
      knownSecrets: () => runtimeKnownSecrets(getConfig()),
      logger,
    }),
  );
  // The fusion project's director tools (issue #39). Registered with the
  // fan-out; their descriptors come and go with it (`filter-disabled-tools`).
  // `project.plan` assigns and estimates from the same live team, policy
  // and outcome history the fan-out routes by.
  for (const tool of buildProjectTools({
    // Issue #100: a correction round needs budget left on the turn's caps.
    correctionBudgetLeft: (sessionId) => {
      if (turnBudget === undefined) return true;
      const mode = resolveCurrentRunMode();
      const limits = {
        ...(mode.turnBudgetUsd === undefined ? {} : { usd: mode.turnBudgetUsd }),
        ...(mode.turnTimeBudgetMs === undefined ? {} : { timeMs: mode.turnTimeBudgetMs }),
      };
      return turnBudget.check(sessionId, limits) === undefined;
    },
    planContext: () => {
      const mode = resolveCurrentRunMode();
      return liveProjectInputsFrom({
        config: getConfig(),
        ...(teamMemberReachable === undefined ? {} : { reachable: teamMemberReachable }),
        allows: currentPolicyAllows,
        mode,
        ...(currentWorker === undefined ? {} : { currentWorker: currentWorker() }),
        ...(currentReviewer === undefined ? {} : { currentReviewer: currentReviewer() }),
        restricted: currentProviderPolicy() !== undefined,
        tokensPerSecond: () => llama.measuredTokensPerSecond(),
        dailyRemainingUsd: null,
      }).plan;
    },
    outsideContent: (sessionId) => approvals.outsideContentSources(sessionId).length > 0,
    // Issue #120: the files, scripts, commands and symbols the draft cites,
    // resolved in the project folder (stat, package.json, bundled ripgrep).
    planReferences: async (rows, projectFolder, signal) => (await checkPlanReferences(rows, { root: projectFolder, signal })).record,
    // Issue #118: the plan reviewer, before the plan gate reaches the
    // person: the folder's policy picks who may review (a refused
    // provider is never asked; `escalationComplete` checks it again), and
    // the spend counts in the turn's budget and receipt.
    planReview: createPlanReview({
      team: () => {
        const team = teamContextFromConfig(getConfig(), teamMemberReachable)?.team;
        if (team === undefined) return undefined;
        const planReviewer = team.planReviewer === undefined ? undefined : parseTeamMember(team.planReviewer) ?? undefined;
        return { ...(planReviewer === undefined ? {} : { planReviewer }), reviewers: teamMembers(team, "reviewers") };
      },
      allows: (providerId) => currentPolicyAllows(providerId) &&
        // A restricted chat never uses a CLI reviewer that keeps its tools on (issue #71).
        !(currentProviderPolicy() !== undefined && isCodexCliProvider(resolveLlmConfig(getConfig()), providerId)),
      restricted: () => currentProviderPolicy() !== undefined,
      reachable: (member) => teamContextFromConfig(getConfig(), teamMemberReachable)?.reachable(member) ?? false,
      pinsModel: (providerId) => teamContextFromConfig(getConfig(), teamMemberReachable)?.pinsModel(providerId) ?? false,
      complete: escalationComplete,
      pricing: (member) => resolveModelPricingFor(resolveLlmConfig(getConfig()), member.model, member.providerId)?.pricing,
      isLocal: (member) => {
        const entry = resolveLlmConfig(getConfig()).providers.find((p) => p.id === member.providerId);
        return entry !== undefined && (entry.kind === "llama-server" || isLocalServerUrl(entry.baseUrl ?? entry.url));
      },
      onSpend: (sessionId, spend) => {
        if (spend.costUsd !== null) turnBudget?.addWorkerSpend(sessionId, spend.costUsd, true);
        turnLedger?.notePlanReview(sessionId, spend);
      },
    }),
    planReviewRounds: () => resolveLlmConfig(getConfig()).runMode?.fusion?.team?.planReviewRounds ?? DEFAULT_FUSION_TEAM_PLAN_REVIEW_ROUNDS,
    // A done milestone's criteria facts and screenshots, from its runs'
    // folders under `<stateDir>/fusion-runs` (issue #40).
    milestoneEvidence: (milestone, criteriaOrder, current) =>
      readMilestoneEvidence({
        runsDir: join(config.paths.stateDir, FUSION_RUNS_DIR_NAME),
        stateDir: config.paths.stateDir,
        runIds: milestone.runIds,
        criteriaOrder,
        ...current,
      }),
  })) {
    toolRegistry.register(tool);
  }
  // Issue #111: the director's backlog proposals, mounted with the project tools.
  toolRegistry.register(buildProjectBacklogTool());
  // Every session reads inside its working directory and the paths the
  // user named unasked, by default (`agent.readScope`,
  // `src/tools/read-scope/`); a read outside that asks through the
  // ladder as `fs_read_outside` — the same gate and surfaces as every
  // other gated action — and a `y` widens the session's roots. A fusion
  // worker is confined more narrowly still — its working directory and
  // its fan-out's write scope, never the brief's — and refused, since
  // nobody is at the other end of its prompt. The shell gets the same
  // scope as a token check. Installed here, after every native
  // filesystem tool and the shell are registered. The scope is re-read
  // per call, so `agent.readScope: "unrestricted"` needs no restart.
  // The agent's own secret files (`.env`, `config.json`, local server
  // keys) ask as `state_secret` on any read or shell command naming
  // them, whatever the scope and below full trust (ATO-877).
  confineReads(toolRegistry, runtimeReadConfinement(config, dangerous));
}

function safePluginMcpServers(
  stateDir: string,
  taken: ReadonlySet<string>,
  logger: StructuredLogger,
): { servers: McpServerConfig[]; owners: Record<string, string> } {
  try {
    const { servers, skipped, owners } = loadPluginMcpServers(stateDir, taken);
    for (const s of skipped) logger.warn("plugin MCP server skipped", { plugin: s.plugin, server: s.server, reason: s.reason });
    return { servers, owners };
  } catch (err) {
    logger.warn("plugin MCP servers unavailable", { error: err instanceof Error ? err.message : String(err) });
    return { servers: [], owners: {} };
  }
}
