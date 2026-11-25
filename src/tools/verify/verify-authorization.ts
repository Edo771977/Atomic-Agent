import { requirePolicyWebUrl } from "../../policy/policy-web.js";
import { verifyPageFolderKey } from "../../approval/verify-page-folder.js";
import { activePolicy } from "../../policy/policy-active.js";
import { policyCallRefusal } from "../../policy/policy-enforce.js";
import { stateDirProjectRecords } from "../../session/project-decisions.js";
import { APPROVED_IMPECCABLE, impeccableArgs, isImpeccableMarkup, resolveImpeccable } from "./impeccable-check.js";
import { canonicalVerifyCwd } from "./verify-canonical-cwd.js";
import { existsSync } from "node:fs";
import { readOsSandboxSettings } from "../../sandbox/os-sandbox.js";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { ApprovalDeniedError, requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { knownSecretsFromEnv, maskSecrets, type KnownSecret } from "../../error-reporting/secret-detector.js";
import { isSecretEnvName } from "../../sandbox/command-env.js";
import { execWriteTargets, shellWriteTargets, type ShellGuardPolicy } from "../os/shell-command-guard/index.js";
import { shellCommandArgv, shellRuleSegments, shellRunsUnreadableScript } from "../os/shell/shell-command-argv.js";
import { formatShellPreview, needsShellInterpretation, shellGrantShape } from "../os/shell/shell-interpretation.js";
import type { CommandReadCheck, ReadTargetCheck } from "../read-scope/confine-reads.js";
import { shellNetworkUrls } from "../os/shell-command-guard/network-clients.js";
import { DEFAULT_URL_DATA_GUARD, requireUrlSendApproval, type UrlDataGuardMode } from "../os/web/url-data-guard.js";
import { isOfflineNetwork, offlineRefusal } from "../../llm/offline-network.js";
import type { ResearchApproval } from "./research-links.js";
import type { ToolContext } from "../tool-registry.js";
import { rebaseVerifyWorkspaceValue } from "./rebase-verify-workspace.js";
import { guardVerifyCommand, guardVerifyRun, verifyRunCommands, verifyRunStdinScript } from "./verify-run-guard.js";
import { isArtifactKind, parseVerifyRunArgs, uiServiceUrl, type VerifyRunArgs } from "./verify-run-args.js";
import { isLocalPageProbe } from "./verify-page-local.js";
import { localFileOfUrl, invalidLocalFileUrlReason } from "../read-scope/read-scope-targets.js";

/** No partial consent: oversized plans are refused before prompting or executing. */
const MAX_AUTHORIZATION_BYTES = 64 * 1024;
export class VerifyGuardRefusal extends Error {
  constructor(readonly guardRule: string, readonly guardReason: string) {
    super(`verify.run: blocked by shell guard: ${guardRule} - ${guardReason}`);
  }
}
/** Approval surfaces must honor the canonical credential set even for non-vendor strings. */
export function maskVerificationSecrets(text: string, known: readonly KnownSecret[]): string {
  let masked = maskSecrets(text, known);
  const values = [...new Set(known.map(secret => secret.value).filter(value => value.length > 0))].sort((a, b) => b.length - a.length);
  for (const value of values) masked = masked.split(value).join("[redacted:credential]");
  return masked;
}
function maskedVerificationValue(value: unknown, known: readonly KnownSecret[]): unknown {
  if (typeof value === "string") return maskVerificationSecrets(value, known);
  if (Array.isArray(value)) return value.map(item => maskedVerificationValue(item, known));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [maskVerificationSecrets(key, known), maskedVerificationValue(item, known)]));
  return value;
}
export const APPROVE_RESEARCH_LINKS = Symbol("approve research link requests");

const UI_UNCHECKABLE = Symbol("UI verification did not run");
export function uiVerificationUnavailable(spec: Record<string, unknown>): string | undefined {
  return (spec as { readonly [UI_UNCHECKABLE]?: string })[UI_UNCHECKABLE];
}
function markUiUnavailable(spec: Record<string, unknown>, reason: string): void {
  Object.defineProperty(spec, UI_UNCHECKABLE, { value: reason });
}

export interface VerifyAuthorizationOptions extends DangerousToolOptions {
  /** Return a verdict for a refused UI check without holding its siblings. */
  continueOnUiApprovalDenial?: boolean;
  /** Final Fusion pass. Service declarations were already authorized in preflight. */
  onlyUi?: boolean;
  researchNetworkRefusal?: string;
  urlDataGuard?: UrlDataGuardMode;
  uiExceptionStateDir?: string;
  shellPolicy?: ShellGuardPolicy;
  checkCommandReads?: CommandReadCheck;
  checkReadTargets?: ReadTargetCheck;
  knownSecrets?: readonly KnownSecret[];
  /** Interactive checks may use a worker's approved scope; contract checks have their own preflight. */
  allowFanoutScope?: boolean;
  /**
   * The folder the session's approved project plan covers. A
   * `verify_page_local` yes for that exact folder then stands for the rest
   * of the turn (`ApprovalGate.grantVerifyPageForTurn`); absent: every
   * probe asks as before.
   */
  turnGrantFolder?: string;
  /** Said on the prompt (reason and preview), e.g. that only part of the session's folder is copied. */
  copyNote?: string;
}
export interface VerifyAuthorizationContext extends ToolContext {
  /** Rules and displayed project paths belong to the original project, never a private copy. */
  ruleWorkdir?: string;
  checkInputs?: readonly string[];
}

/**
 * A page probe that opens a file inside `folder` (`path` or a file: URL),
 * starts nothing and has the network off: the only kind a turn's
 * `verify_page_local` yes may cover. A loopback http(s) URL runs whatever
 * that server serves now, so it always asks.
 */
function opensFileInside(args: VerifyRunArgs, folder: string): boolean {
  if (args.kind !== "page" || args.start !== undefined || args.network) return false;
  const file = args.path !== undefined ? resolve(folder, args.path) : args.url === undefined ? null : localFileOfUrl(args.url);
  if (file === null) return false;
  const rel = relative(resolve(folder), file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function resolveVerifyCwd(root: string, cwd: string | undefined, preserveRootSpelling = false): string {
  const target = cwd === undefined ? resolve(root) : resolve(root, cwd);
  // Windows may spell an existing directory with a drive-case or 8.3
  // alias. Check its filesystem identity, including junctions.
  const sandboxed = readOsSandboxSettings().mode === "workspace";
  if ((process.platform === "win32" || sandboxed) && existsSync(target)) {
    return canonicalVerifyCwd(root, target, preserveRootSpelling && !sandboxed);
  }
  const rel = relative(resolve(root), target);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("verify.run: `cwd` must stay inside the working directory");
  }
  return target;
}

const VERIFICATION_FIELDS = new Set([
  "kind", "type", "id", "service", "cmd", "command", "args", "start", "cwd", "env", "timeoutMs", "network",
  "ready", "requests", "path", "url", "script", "seconds", "probes", "checks", "task", "stdin", "game", "screenshot", "criteria",
  // A fusion contract check's vision judgement (issue #40): read by the
  // judge, stripped before the runner like `task` and `criteria`.
  "judge",
  "requiredSections", "wordRange", "language", "extraPlaceholders", "requiredSheets", "requiredColumns", "totals", "expected", "within", "requireDates",
]);

/** Reject alternative executor meanings before interpreting or describing any plan. */
function assertDeclaredVerificationSchema(spec: Record<string, unknown>, approvalRequired: boolean): void {
  const present = (object: Record<string, unknown>, key: string): boolean => object[key] !== undefined && object[key] !== null;
  if (present(spec, "cmd") && present(spec, "command")) throw new Error("ambiguous verification command: cmd and command cannot both be present");
  if (present(spec, "kind") && present(spec, "type")) throw new Error("ambiguous verification kind: kind and type cannot both be present");
  const kind = spec.kind ?? spec.type;
  const start = typeof spec.start === "object" && spec.start !== null && !Array.isArray(spec.start) ? spec.start as Record<string, unknown> : undefined;
  if (start !== undefined && present(start, "cmd") && present(start, "command")) throw new Error("ambiguous verification start: cmd and command cannot both be present");
  if (approvalRequired) {
    const unsupported = Object.keys(spec).find(key => !VERIFICATION_FIELDS.has(key));
    if (unsupported !== undefined) throw new Error("unsupported verification executor field");
    if (start !== undefined && Object.keys(start).some(key => key !== "cmd" && key !== "args")) throw new Error("unsupported verification start executor field");
  }
  const nonempty = (value: unknown): boolean => typeof value === "string" && value.length > 0 || Array.isArray(value) && value.length > 0;
  if ((kind === "service" || kind === "page") && [spec.cmd, spec.command, spec.args].some(nonempty)) throw new Error("conflicting verification executors: a service or page must use start, not a command");
  if (kind === "command" && start !== undefined && [start.cmd, start.command, start.args].some(nonempty)) throw new Error("conflicting verification executors: a command must not also declare start");
}

/**
 * A check is a verify.run call, including when fusion owns it. This deliberately
 * preserves verify.run tool rules; shell deny/ask command-prefix rules cross
 * that boundary through commandSegments, while shell-only allows never do.
 * All hard refusals and saved denies are checked for the WHOLE batch before
 * the first question, then every check is approved before the runner starts.
 */
export async function authorizeVerifyBatch(
  specs: readonly Record<string, unknown>[],
  options: VerifyAuthorizationOptions,
  ctx: VerifyAuthorizationContext,
): Promise<readonly Record<string, unknown>[]> {
  ctx.signal.throwIfAborted();
  const serialized = JSON.stringify(specs);
  if (Buffer.byteLength(serialized) > MAX_AUTHORIZATION_BYTES) throw new Error("verification authorization plan exceeds the size limit");
  const snapshot = JSON.parse(serialized) as Record<string, unknown>[];
  for (const spec of snapshot) assertDeclaredVerificationSchema(spec, options.approvalRequired);
  const project = ctx.ruleWorkdir ?? ctx.workingDir;
  const known = [...knownSecretsFromEnv(), ...(options.knownSecrets ?? [])];
  const projectRef = ctx.incognito ? undefined : ctx.projectRef;
  const stateDir = options.uiExceptionStateDir;
  const loadExceptions = projectRef === undefined || stateDir === undefined ? undefined : () => {
    const found = stateDirProjectRecords(stateDir).read(projectRef.folder);
    return found.ok && found.record?.id === projectRef.id ? found.record.uiExceptions ?? [] : [];
  };
  const plans = [];
  const services = new Map<string, NonNullable<VerifyRunArgs["ready"]>>();
  for (const spec of snapshot) {
    // The injected runner API historically accepts non-process fixture/check
    // specs too. A trusted embedder explicitly opting out of approvals may
    // keep those; production cannot authorize an undisclosed executor.
    const kind = spec.kind ?? spec.type;
    if (kind === "service" && spec.id != null) {
      const service = parseVerifyRunArgs(spec);
      if (service.id !== undefined) {
        if (services.has(service.id)) throw new Error("duplicate verification service id");
        services.set(service.id, service.ready!);
      }
    }
    if (options.onlyUi && kind !== "ui") continue;
    const namedCommand = typeof spec.cmd === "string" || typeof spec.command === "string" ||
      typeof spec.start === "object" && spec.start !== null;
    if (kind === "command" && !namedCommand) {
      if (!options.approvalRequired) continue;
      throw new Error("verification check has no disclosed command; cannot authorize its executor");
    }
    const policySpec = spec.cmd === undefined && kind === "command" && typeof spec.command === "string" ? { ...spec, kind, cmd: spec.command } : { ...spec, kind };
    const actual = parseVerifyRunArgs(policySpec);
    const policyRefusal = policyCallRefusal(activePolicy(), "verify.run", policySpec, project);
    if (policyRefusal !== null) throw new Error(policyRefusal);
    const actualCwd = resolveVerifyCwd(ctx.workingDir, actual.cwd, true);
    const guard = guardVerifyRun(actual, actualCwd, options.shellPolicy);
    if (guard.blocked !== null) throw new VerifyGuardRefusal(guard.blocked.verdict.rule, guard.blocked.verdict.reason);
    const logical = parseVerifyRunArgs(rebaseVerifyWorkspaceValue(policySpec, ctx.workingDir, project));
    const cwd = resolveVerifyCwd(project, logical.cwd, true);
    const artifactTarget = (isArtifactKind(logical.kind) || logical.kind === "ui") && logical.path !== undefined ? resolve(cwd, logical.path) : undefined;
    const ui = logical.kind === "ui";
    const ready = logical.service === undefined ? undefined : services.get(logical.service);
    if (logical.service !== undefined && ready === undefined) {
      markUiUnavailable(spec, "UI verification requires an earlier named service in the same batch");
      continue;
    }
    let serviceUrl: string | undefined;
    if (ready !== undefined) {
      try {
        serviceUrl = uiServiceUrl(ready);
      } catch (error) {
        markUiUnavailable(spec, error instanceof Error ? error.message : String(error));
        continue;
      }
    }
    const uiTarget = logical.url ?? serviceUrl ?? artifactTarget;
    const supportedUi = logical.url !== undefined || serviceUrl !== undefined || (artifactTarget !== undefined && isImpeccableMarkup(artifactTarget));
    const detector = ui && supportedUi
      ? await resolveImpeccable(ctx.workingDir, actualCwd, ctx.signal) : undefined;
    if (ui && detector === undefined) {
      markUiUnavailable(spec, supportedUi
        ? "impeccable is not installed" : "impeccable scans markup: specify the file that uses this CSS or script");
      continue;
    }
    const detectorArgs = detector === undefined ? undefined : impeccableArgs(uiTarget!);
    const uiVerdicts = detector === undefined ? [] : [
      guardVerifyCommand(detector.file, detectorArgs!, cwd, options.shellPolicy, false),
      guardVerifyCommand(detector.file, ["--version"], cwd, options.shellPolicy, false),
    ];
    const refused = uiVerdicts.find(verdict => verdict.action === "block");
    if (refused !== undefined) throw new VerifyGuardRefusal(refused.rule, refused.reason);
    const commands = detector === undefined ? verifyRunCommands(logical) : [{ cmd: detector.file, args: detectorArgs! }];
    const commandSegments = detector === undefined
      ? commands.flatMap(c => shellRuleSegments(c.cmd, c.args, needsShellInterpretation(c.cmd, c.args)))
      : [detector.file, ...(basename(detector.file) === "impeccable" ? [] : ["impeccable"])].flatMap(exe => [
        [exe, ...detectorArgs!], [exe, "--version"],
      ]);
    const stdinScript = verifyRunStdinScript(logical);
    const commandUnreadable = !ui && (stdinScript?.unreadable === true || commands.some(c => shellRunsUnreadableScript(c.cmd, c.args, needsShellInterpretation(c.cmd, c.args))));
    const targetPaths = ui ? [] : commands.flatMap(c => needsShellInterpretation(c.cmd, c.args) ? shellWriteTargets([c.cmd, ...c.args].join(" "), cwd) : execWriteTargets(c.cmd, c.args, cwd));
    const dangerous = guard.dangerous.length > 0 || uiVerdicts.some(verdict => verdict.action === "approval_required" && verdict.rule.startsWith("dangerous."));
    // A script fed on stdin is not what a grant for the program approved.
    const first = commands.length === 1 && stdinScript === null ? commands[0] : undefined;
    const shape = first === undefined || dangerous || ui ? undefined : shellGrantShape(first.cmd, [first.cmd, ...first.args].join(" "), needsShellInterpretation(first.cmd, first.args));
    const commandArgv = first === undefined ? undefined : ui ? [first.cmd, ...first.args] : shellCommandArgv(first.cmd, first.args, needsShellInterpretation(first.cmd, first.args), shape);
    const env = Object.fromEntries(Object.entries(logical.env ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, isSecretEnvName(name) ? `[redacted:env:${name}]` : value]));
    const metadata = JSON.stringify({ commandArgv, commandSegments, targetPaths });
    const metadataWords = [...(commandArgv ?? []), ...commandSegments.flat(), ...targetPaths];
    const credentialValues = [...known.map(secret => secret.value), ...Object.entries(logical.env ?? {}).filter(([name]) => isSecretEnvName(name)).map(([, value]) => value)];
    const explicitCredential = credentialValues.some(value => value.length > 0 && metadataWords.some(word => word.includes(value)));
    if (explicitCredential || maskSecrets(metadata, [...known, ...knownSecretsFromEnv(logical.env)]) !== metadata) {
      throw new Error("verification command credentials cannot be safely represented in approval metadata; pass credentials through the explicit environment instead");
    }
    const previewKnown = [...known, ...knownSecretsFromEnv(logical.env)];
    const localExecutable = detector === undefined ? undefined : [detector.candidate, detector.file].map(file =>
      relative(ctx.workingDir, file)).find(file => file && file !== ".." && !file.startsWith(`..${sep}`) && !isAbsolute(file));
    const execution = ui
      ? (logical.url ?? serviceUrl) !== undefined
        ? "launch an installed Chromium-based browser selected by Impeccable; the page can load external resources and follow redirects"
        : "run installed impeccable in a private copy of this project"
      : logical.kind === "files" ? "inspect path names and types only"
      : artifactTarget === undefined
      ? "in a private verification copy of this project; absolute project references are rebased into that copy"
      : "read a bounded file snapshot with an offline parser";
    const preview = [
      ...commands.map(c => maskVerificationSecrets(formatShellPreview(c.cmd, c.args, !ui && needsShellInterpretation(c.cmd, c.args)), previewKnown)),
      ...(detector === undefined ? [] : [maskVerificationSecrets(formatShellPreview(detector.file, ["--version"], false), previewKnown)]),
      ...(localExecutable === undefined ? [] : [`project executable: ${maskVerificationSecrets(localExecutable, previewKnown)}`]),
      JSON.stringify(maskedVerificationValue({ ...logical, cwd, env, checkInputs: ctx.checkInputs ?? [], execution }, previewKnown), null, 2),
      ...(options.copyNote === undefined ? [] : [options.copyNote]),
    ].join("\n");
    if (Buffer.byteLength(preview) > MAX_AUTHORIZATION_BYTES) throw new Error("verification authorization preview exceeds the size limit");
    const prompt = {
      sessionId: ctx.sessionId, tool: "verify.run",
      category: dangerous ? "shell_dangerous" as const : ui ? "verify_ui_detector" as const : isLocalPageProbe(logical, cwd, project) ? "verify_page_local" as const : "shell" as const,
      reason: logical.kind === "files" ? `verify file names and types in ${maskVerificationSecrets(cwd, previewKnown)}`
        : ui
        ? `verify UI with ${maskVerificationSecrets(detector!.file, previewKnown)} on ${maskVerificationSecrets(uiTarget!, previewKnown)}`
        : artifactTarget === undefined
        ? `${dangerous ? `${guard.dangerous.map(c => c.verdict.reason).join("; ")} — ` : ""}verify (${logical.kind}) in a throwaway copy of ${cwd}; the copy is not a sandbox${options.copyNote === undefined ? "" : `; ${options.copyNote}`}`
        : `verify (${logical.kind}) by reading ${maskVerificationSecrets(artifactTarget, previewKnown)} offline`,
      preview, affectedResources: detector === undefined ? [artifactTarget ?? cwd] : [cwd, uiTarget!, detector.file], targetPaths, commandSegments,
      ...(commandUnreadable ? { commandUnreadable } : {}),
      ...(commandArgv === undefined ? {} : { commandArgv }), workdir: project,
      // Issue #95: one direct exec (no shell reads it) with no env, no
      // stdin at all (script or data: either is input its words do not
      // show) and no file it would write, so its argv is all that runs.
      ...(detector !== undefined && !(process.platform === "win32" && detector.file.endsWith(".cmd")) ? { verifyPlainCommand: true as const } : {}),
      ...(logical.kind === "command" && first !== undefined && !needsShellInterpretation(first.cmd, first.args) &&
        targetPaths.length === 0 && Object.keys(logical.env ?? {}).length === 0 &&
        (logical.stdin === undefined || logical.stdin === "")
        ? { verifyPlainCommand: true as const } : {}),
    };
    const urls = commands.flatMap(command => {
      const shellLine = needsShellInterpretation(command.cmd, command.args) ? [command.cmd, ...command.args].join(" ") : undefined;
      return [...shellNetworkUrls(command.cmd, command.args, shellLine)];
    });
    for (const [url] of urls) {
      const refused = offlineRefusal(url || "unknown curl destination", "verify.run");
      if (refused) throw refused;
    }
    plans.push({ prompt, logical, cwd, spec, commands, detector, serviceUrl, urls });
  }
  // A deny for a later command wins before asking about an earlier command.
  for (const { prompt, logical, spec } of plans) {
    if (options.approvalRequired && options.approvals.ruleDecisionFor?.(prompt) === "deny") {
      if (logical.kind === "ui" && options.continueOnUiApprovalDenial === true) {
        markUiUnavailable(spec, "impeccable blocked by a saved approval rule");
        continue;
      }
      await requireApproval(options, prompt, ctx.signal);
      throw new ApprovalDeniedError("verify.run", "blocked by a saved rule", { byUser: false });
    }
  }
  const deferUiDenial = (kind: string, spec: Record<string, unknown>, error: unknown): boolean => {
    if (kind !== "ui" || !options.continueOnUiApprovalDenial || !(error instanceof ApprovalDeniedError) || ctx.signal.aborted) return false;
    markUiUnavailable(spec, maskVerificationSecrets(error.message, known));
    return true;
  };
  for (const { logical, cwd, commands, spec } of plans) {
    if (uiVerificationUnavailable(spec) !== undefined) continue;
    const readContext = { ...ctx, workingDir: cwd, readRoots: [project, ...(ctx.readRoots ?? [])] };
    const paths = (logical.kind === "page" || logical.kind === "ui" || isArtifactKind(logical.kind)) && logical.path !== undefined ? [resolve(cwd, logical.path)] : [];
    if (logical.kind === "files") {
      for (const item of logical.expected ?? []) paths.push(resolve(cwd, item.replace(/^(?:file|dir):/u, "")));
      if (logical.within !== undefined) paths.push(resolve(cwd, logical.within));
    }
    const urls = [logical.url, logical.ready?.url, ...(logical.requests ?? []).flatMap(request => [request.url, request.path])];
    for (const url of urls) {
      if (url === undefined) continue;
      const invalid = invalidLocalFileUrlReason(url);
      if (invalid !== null) throw new Error(`verification read target ${invalid}`);
      const path = localFileOfUrl(url);
      if (path !== null) paths.push(path);
    }
    for (const path of new Set(paths)) {
      ctx.signal.throwIfAborted();
      const refusal = await options.checkReadTargets?.("verify.run", { path }, readContext, "os.fs.read").catch(error => {
        if (!deferUiDenial(logical.kind, spec, error)) throw error;
        return null;
      });
      if (uiVerificationUnavailable(spec) !== undefined) break;
      if (refusal !== undefined && refusal !== null) throw new Error(maskSecrets(refusal.summary, known));
    }
    if (uiVerificationUnavailable(spec) !== undefined) continue;
    for (const command of commands) {
      ctx.signal.throwIfAborted();
      const refusal = await options.checkCommandReads?.("verify.run", { cmd: command.cmd, args: command.args, env: logical.env }, readContext).catch(error => {
        if (!deferUiDenial(logical.kind, spec, error)) throw error;
        return null;
      });
      if (uiVerificationUnavailable(spec) !== undefined) break;
      if (refusal !== undefined && refusal !== null) throw new Error(maskSecrets(refusal.summary, known));
    }
  }
  for (const { prompt, cwd, logical, spec, detector, serviceUrl, urls } of plans) {
    ctx.signal.throwIfAborted();
    if (uiVerificationUnavailable(spec) !== undefined) continue;
    if (logical.kind === "ui" && options.continueOnUiApprovalDenial && options.approvalRequired &&
        typeof options.approvals.request !== "function") {
      markUiUnavailable(spec, "impeccable approval gate is unavailable");
      continue;
    }
    const authorizeUrls = async () => {
      for (const [url, sendsQueryData] of urls) {
        await requirePolicyWebUrl(options, "verify.run", url, ctx);
        await requireUrlSendApproval(options, {
          mode: options.urlDataGuard ?? DEFAULT_URL_DATA_GUARD,
          tool: "verify.run",
          url,
          sendsQueryData,
          sessionId: ctx.sessionId,
          signal: ctx.signal,
        });
      }
    };
    const scoped = options.allowFanoutScope === true && (prompt.category === "shell" || prompt.category === "verify_page_local") &&
      !(options.approvals.holdsForOutsideContent?.(ctx.sessionId, "shell") ?? false) &&
      (options.approvals.fanoutScopes?.allows(ctx.sessionId, [cwd]) ?? false) &&
      !(options.approvals.hasDeclinedTarget?.(prompt) ?? false) &&
      !["deny", "ask"].includes(options.approvals.ruleDecisionFor?.(prompt) ?? "");
    if (scoped) {
      await authorizeUrls();
      continue;
    }
    // A local page probe of a folder already approved this turn (in the
    // approved plan's folder) runs unasked, unless a saved rule asks or
    // denies, or the person declined the target (the gate also refuses it
    // after outside content). Every other category keeps "Allow once".
    const page = prompt.category === "verify_page_local" && opensFileInside(logical, cwd);
    if (page && (options.approvals.verifyPageGrantedForTurn?.(ctx.sessionId, cwd) ?? false) &&
      !(options.approvals.hasDeclinedTarget?.(prompt) ?? false) &&
      !["deny", "ask"].includes(options.approvals.ruleDecisionFor?.(prompt) ?? "")) {
      await authorizeUrls();
      continue;
    }
    // The gate records the turn grant only if a person approves this request.
    const grantFolder = page && options.turnGrantFolder !== undefined ? verifyPageFolderKey(options.turnGrantFolder) : undefined;
    const withdraw = options.approvalRequired && grantFolder !== undefined &&
      grantFolder === verifyPageFolderKey(cwd)
      ? options.approvals.offerVerifyPageTurnGrant?.(ctx.sessionId, cwd)
      : undefined;
    try {
      const outcome = await requireApproval(options, prompt, ctx.signal);
      const actualArgs = Array.isArray(spec.args) ? spec.args : [];
      const pin = outcome.pinnedExec;
      if (logical.kind === "ui" || pin === undefined || pin.argv.length !== actualArgs.length + 1 ||
        !actualArgs.every((arg, index) => arg === pin.argv[index + 1])) await authorizeUrls();
      // Issue #95: a host's pin (`run --allow-command`) is what runs: the
      // real program file with the approved argv, never a name the copy's
      // PATH could resolve to something else. The private copy stays the cwd.
      if (logical.kind === "ui") {
        if (outcome.pinnedExec !== undefined && outcome.pinnedExec.file !== detector?.file) {
          throw new Error("verify.run: the pinned file differs from the approved impeccable executable");
        }
        const exceptionFile = projectRef === undefined || logical.path === undefined ? undefined
          : relative(project, resolve(cwd, logical.path)).split(sep).join("/");
        Object.defineProperty(spec, APPROVED_IMPECCABLE, {
          value: detector === undefined ? undefined : { ...detector, loadExceptions, exceptionFile, serviceUrl, path: outcome.pinnedExec?.path },
        });
      } else if (outcome.pinnedExec !== undefined) {
        // requireApproval checked the pin's argv against this check's
        // logical (project) argv; the spec keeps its own args, which name
        // the private copy, and only the program is swapped.
        const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
        if (needsShellInterpretation(outcome.pinnedExec.file, args)) throw new Error("verify.run: the pinned program cannot be started without a shell");
        delete spec.command;
        spec.cmd = outcome.pinnedExec.file;
        // Only the pin's filtered PATH: see `PinnedExec.path`.
        spec.env = { PATH: outcome.pinnedExec.path };
      }
    } catch (error) {
      if (!deferUiDenial(logical.kind, spec, error)) throw error;
    } finally {
      withdraw?.();
    }
  }
  ctx.signal.throwIfAborted();
  return snapshot.map(spec => attachResearchNetworkApproval(spec, options, ctx));
}

/** Attach the lazy network approval without repeating the local preflight. */
export function researchUrlMayBeDisclosed(url: string, known: readonly KnownSecret[]): boolean {
  return redactResearchUrl(url, known) === url;
}

export function redactResearchUrl(url: string, known: readonly KnownSecret[]): string {
  const masked = maskVerificationSecrets(url, known);
  if (masked !== url) return masked;
  try {
    const decoded = decodeURIComponent(url);
    return maskVerificationSecrets(decoded, known) === decoded ? url : "[redacted:source URL]";
  } catch {
    return url;
  }
}

export function attachResearchNetworkApproval(
  spec: Record<string, unknown>,
  options: Pick<VerifyAuthorizationOptions, "approvals" | "knownSecrets" | "researchNetworkRefusal">,
  ctx: Pick<VerifyAuthorizationContext, "sessionId" | "signal" | "workingDir" | "ruleWorkdir">,
): Record<string, unknown> {
  if ((spec.kind ?? spec.type) !== "research" || spec.network !== true) return spec;
  const project = ctx.ruleWorkdir ?? ctx.workingDir;
  const known = [...knownSecretsFromEnv(), ...(options.knownSecrets ?? [])];
  const approve: ResearchApproval = async links => {
    if (options.researchNetworkRefusal !== undefined) return maskVerificationSecrets(options.researchNetworkRefusal, known);
    if (isOfflineNetwork()) return "runtime is offline";
    if (typeof options.approvals.request !== "function") return "network approval unavailable";
    ctx.signal.throwIfAborted();
    const urls = links.map(link => link.url);
    if (urls.some(url => !researchUrlMayBeDisclosed(url, known))) return "source URLs contain a hidden value";
    const decision = await options.approvals.request({
      sessionId: ctx.sessionId, tool: "verify.run", category: "http", workdir: project,
      reason: `verify the reachability of ${urls.length} research URL(s), following up to three redirects per URL`,
      preview: urls.join("\n"), affectedResources: urls,
    }, { signal: ctx.signal, requireExplicitDecision: true });
    return decision.approved && decision.automatic !== true ? undefined : "explicit network approval unavailable or declined";
  };
  return Object.defineProperty({ ...spec }, APPROVE_RESEARCH_LINKS, { value: approve });
}
