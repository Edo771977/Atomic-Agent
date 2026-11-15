import type { EgressClass } from "../config/project-constraints-config.js";
import type { ProviderPolicy } from "../config/project-constraint-match.js";
import { hostOfUrl, isLoopbackHost } from "../llm/offline-network.js";
import { shellNetworkUse, type ShellNetworkUse } from "./os/shell-command-guard/network-clients.js";
import { SHELL_TOOL, VERIFY_TOOL, verifyRunShellCalls } from "./read-scope/read-scope-targets.js";

export type { EgressClass } from "../config/project-constraints-config.js";

/**
 * Per-folder egress constraints (issue #33): which tool calls would send
 * a constrained folder's content off this machine, and the refusal they
 * get unless the folder's `allowedEgress` names their class. See
 * ../llm/docs/provider-policy.md.
 *
 * The inventory below follows the offline-mode refusal points
 * (`offlineRefusal` / `offlineRefusalFor`) and the tool catalog:
 *
 * - `web`: `os.web.search`, `os.web.fetch` (a loopback URL stays local);
 * - `http`: `os.http.request` (curl underneath; loopback stays local);
 * - `browser`: every `browser.*` tool. The page a click or a read acts
 *   on may be remote whatever this call's arguments say, so the whole
 *   browser is one class;
 * - `github`: every `github.*` tool (the GitHub API);
 * - `git`: `os.git.fetch`, `pull`, `push`, `clone` (a remote);
 * - `mail`: `os.email.*` (Atomic Mail);
 * - `channels`: `tasks.schedule` / `tasks.cron` with `notify` (the
 *   result goes to the paired Telegram chat);
 * - `composio`: tools of the Composio MCP server;
 * - `mcp:<server>`: tools of a remote (http / SSE) MCP server, and the
 *   `mcp.resource.*` / `mcp.prompt.*` meta-tools naming one. A stdio
 *   server is a local process and is not classed: it may still reach the
 *   network itself, which nothing here can see.
 *
 * Shell commands (`os.shell.run`, every command of `verify.run`) are
 * checked best effort (`shellNetworkUse`): a known network client
 * (`curl`, `wget`, `Invoke-WebRequest`, `npm publish` → `http`; `git
 * push/fetch/pull/clone` → `git`; `gh` → `github`; `ssh`, `scp`,
 * `rsync host:`, `nc`, `telnet`, `ftp` → no class allows them) is
 * refused unless its class is listed. The shell is not a sandbox: a
 * script, an interpreter one-liner or a renamed binary still opens its
 * own sockets, and `skill.run_script` is not inspected. Model,
 * embedding and media endpoints are the provider policy's
 * (`allowedProviders`), not this one's.
 */

export const EGRESS_NOT_ALLOWED_CODE = "ATOMIC_AGENT_EGRESS_NOT_ALLOWED";

export interface EgressTarget {
  readonly cls: EgressClass;
}

export interface EgressClassifierDeps {
  /**
   * The class of the MCP server behind an MCP tool or meta-tool call:
   * `null` for a local (stdio) server, `"composio"` or `mcp:<server>`
   * for a remote one, `undefined` when it cannot tell (then a tool named
   * `mcp.<server>.<tool>` counts as `mcp:<server>`: fail closed).
   */
  mcpEgress?: (tool: string, args: Record<string, unknown>) => EgressClass | null | undefined;
}

const GIT_REMOTE_TOOLS = new Set(["os.git.fetch", "os.git.pull", "os.git.push", "os.git.clone"]);
export const MCP_META_TOOLS: ReadonlySet<string> = new Set(["mcp.resource.list", "mcp.resource.read", "mcp.prompt.list", "mcp.prompt.get"]);

/** A URL argument that points at this machine (loopback); anything else may leave it. */
function isLocalUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const host = hostOfUrl(raw.trim());
  return host !== null && isLoopbackHost(host);
}

/** The egress class `tool` called with `args` falls in, or `null` when it stays on this machine. */
export function egressTargetOf(
  tool: string,
  args: Record<string, unknown>,
  deps: EgressClassifierDeps = {},
): EgressTarget | null {
  if (tool === "os.web.search") return { cls: "web" };
  if (tool === "os.web.fetch") return isLocalUrl(args.url) ? null : { cls: "web" };
  if (tool === "os.http.request") return isLocalUrl(args.url) ? null : { cls: "http" };
  if (tool.startsWith("browser.")) return { cls: "browser" };
  if (tool.startsWith("github.")) return { cls: "github" };
  if (GIT_REMOTE_TOOLS.has(tool)) return { cls: "git" };
  if (tool.startsWith("os.email.")) return { cls: "mail" };
  if ((tool === "tasks.schedule" || tool === "tasks.cron") && args.notify !== undefined) return { cls: "channels" };
  if (MCP_META_TOOLS.has(tool)) {
    const cls = deps.mcpEgress?.(tool, args);
    if (cls !== undefined) return cls === null ? null : { cls };
    return typeof args.server === "string" && args.server.length > 0 ? { cls: `mcp:${args.server}` } : null;
  }
  if (tool.startsWith("mcp.")) {
    const cls = deps.mcpEgress?.(tool, args);
    if (cls !== undefined) return cls === null ? null : { cls };
    const server = tool.split(".")[1] ?? "";
    return { cls: `mcp:${server.length > 0 ? server : "(unknown)"}` };
  }
  return null;
}

/** A tool call refused because the folder's constraint does not allow its egress class. */
export class EgressNotAllowedError extends Error {
  readonly code = EGRESS_NOT_ALLOWED_CODE;
  readonly tool: string;
  readonly egressClass: EgressClass;
  readonly policyKey: string;

  constructor(tool: string, cls: EgressClass, policy: ProviderPolicy) {
    super(
      `folder ${policy.key} is restricted: ${tool} would send content off this machine; ` +
      `add ${JSON.stringify(cls)} to projects.constraints[${JSON.stringify(policy.key)}].allowedEgress to allow it`,
    );
    this.name = "EgressNotAllowedError";
    this.tool = tool;
    this.egressClass = cls;
    this.policyKey = policy.key;
  }
}

/** A shell command refused because it runs a network client in a constrained folder (best effort). */
export class ShellNetworkNotAllowedError extends Error {
  readonly code = EGRESS_NOT_ALLOWED_CODE;
  readonly tool: string;
  readonly program: string;
  readonly egressClass: EgressClass | null;
  readonly policyKey: string;

  constructor(tool: string, use: ShellNetworkUse, policy: ProviderPolicy) {
    const how = use.cls === null
      ? "no allowedEgress class allows it"
      : `add ${JSON.stringify(use.cls)} to projects.constraints[${JSON.stringify(policy.key)}].allowedEgress to allow it`;
    super(
      `folder ${policy.key} is restricted: ${tool} runs ${use.program}, a network client that could send content off this machine; ${how}. ` +
      "This is a best-effort check of the command line; the shell is not a sandbox",
    );
    this.name = "ShellNetworkNotAllowedError";
    this.tool = tool;
    this.program = use.program;
    this.egressClass = use.cls;
    this.policyKey = policy.key;
  }
}

/** The first network client a shell or `verify.run` call would run, or `null`. */
export function shellNetworkUseOf(tool: string, args: Record<string, unknown>): ShellNetworkUse | null {
  const calls = tool === SHELL_TOOL ? [args] : tool === VERIFY_TOOL ? verifyRunShellCalls(args) : [];
  for (const call of calls) {
    const use = shellNetworkUse(call);
    if (use !== null) return use;
  }
  return null;
}

export interface EgressGuardDeps extends EgressClassifierDeps {
  /**
   * The policy that governs `sessionId` right now (the runtime's
   * `effectivePolicyForSession`), `undefined` for an unconstrained one.
   */
  policyForSession: (sessionId: string) => ProviderPolicy | undefined;
}

/**
 * The dispatch guard the tool registry runs before a call (before its
 * approval prompt and before anything is sent): the refusal, or `null`
 * when the call may go ahead.
 */
export function createEgressGuard(deps: EgressGuardDeps) {
  return (
    tool: string,
    args: Record<string, unknown>,
    ctx: { sessionId: string },
  ): EgressNotAllowedError | ShellNetworkNotAllowedError | null => {
    const shell = shellNetworkUseOf(tool, args);
    if (shell !== null) {
      const policy = deps.policyForSession(ctx.sessionId);
      if (policy === undefined || (shell.cls !== null && policy.allowsEgress(shell.cls))) return null;
      return new ShellNetworkNotAllowedError(tool, shell, policy);
    }
    const target = egressTargetOf(tool, args, deps);
    if (target === null) return null;
    const policy = deps.policyForSession(ctx.sessionId);
    if (policy === undefined || policy.allowsEgress(target.cls)) return null;
    return new EgressNotAllowedError(tool, target.cls, policy);
  };
}
