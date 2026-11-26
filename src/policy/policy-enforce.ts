import { matchPolicyGlob } from "./policy-glob.js";
import { programName } from "../tools/os/shell-command-guard/command-segments.js";
import { changesPolicyChildMetadata } from "./policy-child-env-guard.js";
/**
 * The admin policy turned into the answers each integration point needs.
 * Approval logic stays in `src/approval/`: the gate only receives a rule
 * match shaped like one of its saved rules.
 */
import type { ApprovalRule, RuleMatch } from "../approval/approval-rules.js";
import { dirname, relative, isAbsolute, sep } from "node:path";
import { policyFilePaths as policyFiles, createEditPathNormalizer } from "./policy-paths.js";
import { READ_TOOL_TARGETS, verifyRunShellCalls } from "../tools/read-scope/read-scope-targets.js";
import { shellNetworkUrls } from "../tools/os/shell-command-guard/network-clients.js";
import { analyzeShellRules } from "../tools/os/shell/org-shell-analysis.js";
import { coerceShellArgs, needsShellInterpretation } from "../tools/os/shell/shell-interpretation.js";
import { findShellStateSecrets } from "../tools/read-scope/state-secrets.js";
import { shellWriteTargets, execWriteTargets, type WriteTargetScope } from "../tools/os/shell-command-guard/write-targets.js";
import {
  describePolicyRule,
  evaluatePolicy,
  mcpServerVerdict,
  type EffectivePolicy,
  type McpServerVerdict,
  type PolicyVerdict,
} from "./policy-evaluator.js";
import { gateRequestTarget, toolCallTarget, type PolicyGateRequest, type PolicyTarget } from "./policy-targets.js";

/** Even an approval cannot authorize the agent to replace its own policy. */
type EditPathNormalizer = ReturnType<typeof createEditPathNormalizer>;
function touchesPolicy(policy: EffectivePolicy, paths: readonly string[], workingDir = process.cwd(), ancestors = false, normalize = createEditPathNormalizer(workingDir)): boolean {
  const protectedPaths = policyFiles(policy);
  if (paths.length === 0 || protectedPaths.length === 0) return false;
  const lexicalFiles = new Set(protectedPaths.map(normalize.lexical));
  if (paths.some(path => lexicalFiles.has(normalize.lexical(path)))) return true;
  const candidates = protectedPaths.filter(normalize.mayExist);
  if (candidates.length === 0) return false;
  const protectedFiles = candidates.map(normalize.path);
  return paths.some(path => protectedFiles.some(file => {
    const offset = relative(normalize.path(path), file);
    return offset === "" || ancestors && !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
  }));
}

function protectedPolicyMatch(tool: string): RuleMatch {
  return { decision: "deny", rule: { id: "org-policy:protected-file", decision: "deny", tool, createdAt: "", source: "user", note: "Only the operator may inspect or change organization policy files outside agent tools" } };
}

function verdictFor(policy: EffectivePolicy, target: PolicyTarget | null, workingDir?: string, normalize = createEditPathNormalizer(workingDir)): PolicyVerdict | null {
  if (target === null || policy.rules.length === 0) return null;
  if (target.action === "edit") {
    const normalized = { ...policy, rules: policy.rules.map(rule => rule.action === "edit" ? { ...rule, resource: normalize.pattern(rule.resource) } : rule) };
    return evaluatePolicy(normalized, "edit", target.resources.map(normalize.path), { unreadable: target.unreadable === true });
  }
  return evaluatePolicy(policy, target.action, target.resources, { unreadable: target.unreadable === true });
}

/**
 * For `ApprovalGate.setOrgPolicy`: a policy `deny` blocks the request and
 * an `ask` puts it to a person whatever the approval level, a session
 * grant or a saved allow rule says. A policy `allow` changes nothing: it
 * only cancels an earlier `ask` of the policy itself, it never skips a
 * prompt the user's own settings would show.
 */
export function policyRuleMatch(policy: EffectivePolicy, request: PolicyGateRequest): RuleMatch | null {
  const normalize = createEditPathNormalizer(request.workdir);
  if ((request.category === "trust_config" || request.category === "state_secret") &&
      (touchesPolicy(policy, request.targetPaths ?? [], request.workdir, request.category === "trust_config", normalize) ||
       touchesPolicy(policy, request.affectedResources ?? [], request.workdir, false, normalize))) return protectedPolicyMatch(request.tool);
  const verdict = verdictFor(policy, gateRequestTarget(request, normalize), request.workdir, normalize);
  if (verdict === null || verdict.effect === "allow") return null;
  const rule: ApprovalRule = {
    id: `org-policy:${verdict.rule.source}:${verdict.rule.index + 1}`,
    decision: verdict.effect,
    tool: request.tool,
    createdAt: "",
    source: "user",
    note: describePolicyRule(verdict.rule),
  };
  return { decision: verdict.effect, rule };
}

function shellAnalysisForCall(): typeof analyzeShellRules {
  const analyses = new Map<string, ReturnType<typeof analyzeShellRules>>();
  return (cmd, rest, useShell, dialect) => {
    const key = JSON.stringify([cmd, rest, useShell, dialect]);
    let value = analyses.get(key);
    if (value === undefined) { value = analyzeShellRules(cmd, rest, useShell, dialect); analyses.set(key, value); }
    return value;
  };
}

/** One explicit invocation scope; never stored in a session or reused by invoke. */
export function createPolicyEvaluation(policy: EffectivePolicy, workingDir: string) {
  const baseAnalyze = shellAnalysisForCall();
  const aliases = new Map<string, ReturnType<typeof analyzeShellRules>>();
  const analysisKey = (cmd: string, args: readonly string[], shell: boolean, dialect?: string) => JSON.stringify([cmd, args, shell, dialect]);
  const analyze: typeof analyzeShellRules = (cmd, args, shell, dialect) => aliases.get(analysisKey(cmd, args, shell, dialect)) ?? baseAnalyze(cmd, args, shell, dialect);
  const normalizers = new Map<string, EditPathNormalizer>();
  const inspections = new Map<string, string | null>();
  return {
    refusal(tool: string, args: Record<string, unknown>, cwd = workingDir): string | null {
      const relevant = tool === "os.shell.run" ? { cmd: args.cmd, args: coerceShellArgs(args.args) ?? [], cwd: args.cwd ?? cwd } : args;
      const key = JSON.stringify([tool, relevant, cwd]);
      if (inspections.has(key)) return inspections.get(key)!;
      let normalize = normalizers.get(cwd);
      if (normalize === undefined) { normalize = createEditPathNormalizer(cwd); normalizers.set(cwd, normalize); }
      const refusal = policyCallRefusal(policy, tool, args, cwd, normalize, analyze);
      inspections.set(key, refusal); return refusal;
    },
    asks: (tool: string, args: Record<string, unknown>) => policyCallAsks(policy, tool, args, analyze),
    shellSpawnRefusal(cmd: string, args: readonly string[], file: string, argv: readonly string[], cwd = workingDir): string | null {
      if (policy.rules.length > 0 || policy.sources.some(source => source.state === "loaded") || policyFiles(policy).some((normalizers.get(cwd) ?? createEditPathNormalizer(cwd)).mayExist)) {
        const original = analyze(cmd, args, needsShellInterpretation(cmd, args));
        aliases.set(analysisKey(file, argv, needsShellInterpretation(file, argv)), { ...original, segments: [[file, ...argv], ...original.segments] });
      }
      return this.refusal("os.shell.run", { cmd: file, args: [...argv] }, cwd);
    },
  };
}

/** The model-facing refusal for a tool call the policy denies, or null. */
export function policyCallAsks(policy: EffectivePolicy, tool: string, args: unknown, analyze = analyzeShellRules): boolean {
  if (policy.rules.length === 0) return false;
  return verdictFor(policy, toolCallTarget(tool, args, analyze))?.effect === "ask";
}

/** The model-facing refusal for a tool call the policy denies, or null. */
export function policyCallRefusal(policy: EffectivePolicy, tool: string, args: unknown, workingDir?: string, normalize: EditPathNormalizer = createEditPathNormalizer(workingDir), analyze = shellAnalysisForCall()): string | null {
  const target = policy.rules.length === 0 && (tool === "os.shell.run" || tool === "verify.run") ? null : toolCallTarget(tool, args, analyze);
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const object = record(args);
  const commands = tool === "os.shell.run" ? [object] : tool === "verify.run" ? verifyRunShellCalls(object) : [];
  if (policy.rules.length > 0 || policy.sources.some(source => source.state === "loaded") || policyFiles(policy).some(normalize.mayExist)) {
    for (const command of commands) {
      if (typeof command.cmd !== "string") continue;
      const args = coerceShellArgs(command.args) ?? [];
      if (changesPolicyChildMetadata(command.cmd, args, needsShellInterpretation(command.cmd, args))) return `${tool} was not run: inherited organization policy metadata is reserved for the operator.`;
    }
  }
  if (policy.rules.some(rule => rule.action === "webfetch" && rule.effect !== "allow")) {
    for (const command of commands) {
      if (typeof command.cmd !== "string") continue;
      const rest = coerceShellArgs(command.args) ?? [];
      const segments = analyze(command.cmd, rest, needsShellInterpretation(command.cmd, rest)).segments;
      for (const words of segments) for (const url of shellNetworkUrls(words[0] ?? "", words.slice(1)).keys()) {
        const verdict = evaluatePolicy(policy, "webfetch", url === "" ? [] : toolCallTarget("os.web.fetch", { url })!.resources, { unreadable: url === "" });
        if (verdict?.effect === "deny") return `${tool} was not run: blocked by organization policy (${describePolicyRule(verdict.rule)}) for a shell network destination.`;
      }
    }
  }
  if (tool === "verify.run") {
    const ready = record(object.ready);
    const urls = [object.url, ready.url, ...(Array.isArray(object.requests) ? object.requests.map(request => record(request).url) : [])];
    if (typeof ready.port === "number") urls.push(`http://127.0.0.1:${ready.port}/`);
    for (const url of urls) {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
      const refusal = policyCallRefusal(policy, "os.web.fetch", { url }, workingDir);
      if (refusal !== null) return refusal.replace("os.web.fetch", tool);
    }
  }
  const readPaths = READ_TOOL_TARGETS.get(tool)?.(object) ?? [];
  const files = policyFiles(policy);
  const shellCommands = tool === "os.shell.run" ? [object] : tool === "verify.run" ? [object, record(object.start)] : [];
  // A remote-only source has rules, but no local file inventory to inspect.
  const shellTouchesPolicy = files.length > 0 && (policy.sources.some(source => source.state === "loaded") || files.some(normalize.mayExist)) && shellCommands.some(command => {
    if (typeof command.cmd !== "string") return false;
    const cwd = workingDir ?? process.cwd();
    const named = findShellStateSecrets(command, { workingDir: cwd }, {
      stateDir: dirname(policy.sources.find(source => source.kind === "user")?.location ?? files[0]!), files,
    });
    if (touchesPolicy(policy, named, cwd, false, normalize)) return true;
    const args = coerceShellArgs(command.args) ?? [];
    const segments = analyze(command.cmd, args, needsShellInterpretation(command.cmd, args)).segments;
    const readsTree = segments.some(words => /^(?:tar|zip|7z|7za|rar|cpio|rg)$/.test(programName(words[0] ?? "")) || programName(words[0] ?? "") === "grep" && words.slice(1).some(arg => /^-[A-Za-z]*[rR]/.test(arg) || arg === "--recursive"));
    if (readsTree && touchesPolicy(policy, [...named, ...segments.flatMap(words => words.slice(1).filter(word => word && !word.startsWith("-")))], cwd, true, normalize)) return true;
    const words = segments.flatMap(segment => segment.slice(1));
    for (const pattern of words.filter(word => /[*?]/.test(word))) {
      if (files.filter(normalize.mayExist).some(file => matchPolicyGlob(normalize.pattern(pattern), normalize.path(file)) !== false)) return true;
    }
    const scope: WriteTargetScope = { recursive: [], placed: [] };
    const writes = needsShellInterpretation(command.cmd, args) ? shellWriteTargets([command.cmd, ...args].join(" "), cwd, scope) : execWriteTargets(command.cmd, args, cwd, scope);
    const literalWrites = needsShellInterpretation(command.cmd, args) ? [] : (scope.patterns ?? []).filter(pattern => !/[?*]/.test(pattern));
    return touchesPolicy(policy, [...writes, ...literalWrites, ...scope.recursive, ...scope.placed], cwd, true, normalize);
  });
  if (shellTouchesPolicy || touchesPolicy(policy, readPaths, workingDir, false, normalize) ||
      touchesPolicy(policy, target?.action === "edit" ? target.resources : [], workingDir, true, normalize)) {
    return `${tool} was not run: organization policy files are protected; only the operator may inspect or change them outside agent tools.`;
  }
  const verdict = verdictFor(policy, target, workingDir, normalize);
  if (verdict?.effect !== "deny") return null;
  return (
    `${tool} was not run: blocked by your organization's policy (${describePolicyRule(verdict.rule)}).\n` +
    "This rule was set by an administrator, not a tool failure: do not retry the same call or " +
    "try another way to do the same thing; tell the user it is not allowed here."
  );
}

/** Why a skill may not be installed or loaded, or null when it may. */
export function skillPolicyRefusal(policy: EffectivePolicy, name: string): string | null {
  const verdict = verdictFor(policy, { action: "skill", resources: [name] });
  if (verdict?.effect !== "deny") return null;
  return `skill "${name}" is blocked by your organization's policy (${describePolicyRule(verdict.rule)})`;
}

/** The parts of an MCP server config the allowlist reads (structural, no MCP import). */
export interface PolicyMcpServerConfig {
  name: string;
  transport: { kind: string; command?: string; args?: string[]; url?: string };
}

/** For `McpManagerDeps.serverPolicy`: the allowlist verdict for one configured server. */
export function mcpServerPolicy(policy: EffectivePolicy, config: PolicyMcpServerConfig): McpServerVerdict {
  const t = config.transport;
  const command = t.command !== undefined ? [t.command, ...(t.args ?? [])].join(" ") : undefined;
  return mcpServerVerdict(policy, {
    name: config.name,
    ...(t.url !== undefined ? { url: t.url } : {}),
    ...(command !== undefined ? { command } : {}),
  });
}
