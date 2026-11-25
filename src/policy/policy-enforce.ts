/**
 * The admin policy turned into the answers each integration point needs.
 * Approval logic stays in `src/approval/`: the gate only receives a rule
 * match shaped like one of its saved rules.
 */
import type { ApprovalRule, RuleMatch } from "../approval/approval-rules.js";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { canonicalPolicyPath as canonicalPath, policyFilePaths as policyFiles } from "./policy-paths.js";
import { READ_TOOL_TARGETS } from "../tools/read-scope/read-scope-targets.js";
import { findShellStateSecrets } from "../tools/read-scope/state-secrets.js";
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
function touchesPolicy(policy: EffectivePolicy, paths: readonly string[], workingDir = process.cwd(), ancestors = false): boolean {
  const protectedPaths = policyFiles(policy);
  return paths.some(path => protectedPaths.some(file => {
    const target = canonicalPath(resolve(workingDir, path));
    const protectedFile = canonicalPath(resolve(file));
    const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    const offset = relative(normalize(target), normalize(protectedFile));
    return offset === "" || ancestors && !isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`);
  }));
}

function protectedPolicyMatch(tool: string): RuleMatch {
  return { decision: "deny", rule: { id: "org-policy:protected-file", decision: "deny", tool, createdAt: "", source: "user", note: "Only the operator may inspect or change organization policy files outside agent tools" } };
}

function verdictFor(policy: EffectivePolicy, target: PolicyTarget | null): PolicyVerdict | null {
  if (target === null || policy.rules.length === 0) return null;
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
  if ((request.category === "trust_config" || request.category === "state_secret") &&
      touchesPolicy(policy, [...(request.targetPaths ?? []), ...(request.affectedResources ?? [])], undefined, request.category === "trust_config")) return protectedPolicyMatch(request.tool);
  const verdict = verdictFor(policy, gateRequestTarget(request));
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

/** The model-facing refusal for a tool call the policy denies, or null. */
export function policyCallAsks(policy: EffectivePolicy, tool: string, args: unknown): boolean {
  return verdictFor(policy, toolCallTarget(tool, args))?.effect === "ask";
}

/** The model-facing refusal for a tool call the policy denies, or null. */
export function policyCallRefusal(policy: EffectivePolicy, tool: string, args: unknown, workingDir?: string): string | null {
  const target = toolCallTarget(tool, args);
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const object = record(args);
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
  const shellTouchesPolicy = files.length > 0 && shellCommands.some(command => typeof command.cmd === "string" && findShellStateSecrets(command, { workingDir: workingDir ?? process.cwd() }, {
    stateDir: dirname(policy.sources.find(source => source.kind === "user")?.location ?? files[0]!), files,
  }).length > 0);
  if (shellTouchesPolicy || touchesPolicy(policy, readPaths, workingDir) ||
      touchesPolicy(policy, target?.action === "edit" ? target.resources : [], workingDir, true)) {
    return `${tool} was not run: organization policy files are protected; only the operator may inspect or change them outside agent tools.`;
  }
  if (target?.action === "edit" && workingDir !== undefined) {
    target.resources = [...new Set(target.resources.flatMap(path => {
      const absolute = resolve(workingDir, path);
      return [path, absolute, canonicalPath(absolute)].flatMap(value => [value, value.replace(/\\/g, "/")]);
    }))];
  }
  const verdict = verdictFor(policy, target);
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
