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
 * - `web`: `os.web.search`, `os.web.fetch`, `os.web.crawl` (a loopback
 *   URL stays local). `os.web.fetch`'s bot-wall ladder (ATO-968) asks
 *   again per step (`webFetchStepEgress`): rendering in the agent's
 *   browser is `browser`, sending the URL to Jina Reader or Firecrawl is
 *   `http` (a third-party API request); a refused step is skipped;
 * - `http`: `os.http.request` (curl underneath; loopback stays local);
 * - `browser`: every `browser.*` tool. The page a click or a read acts
 *   on may be remote whatever this call's arguments say, so the whole
 *   browser is one class. A `verify.run` page probe (`kind: "page"`)
 *   is a headless browser too and is classed the same, whatever it
 *   opens: a local file or a loopback page can still load remote
 *   resources (its `network: false` block is a soft one).
 *   `video.render_html` records a page in the same headless browser, so
 *   it is `browser` too;
 * - `github`: every `github.*` tool (the GitHub API);
 * - `git`: `os.git.fetch`, `pull`, `push`, `clone` (a remote);
 * - `mail`: `os.email.*` (Atomic Mail);
 * - `channels`: `tasks.schedule` / `tasks.cron` with `notify` (the
 *   result goes to the paired Telegram chat);
 * - `composio`: tools of the Composio MCP server;
 * - `mcp:<server>`: tools of an MCP server, and the `mcp.resource.*` /
 *   `mcp.prompt.*` meta-tools naming one: every remote (http / SSE)
 *   server and every stdio server not marked `local: true` (issue #60:
 *   a stdio process may fetch, browse or call an API itself). Only a
 *   stdio server whose config says `local: true` is not classed; that
 *   flag is the operator's word, nothing here checks it.
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
 *
 * Not classed, as they send nothing of the folder: `audio.transcribe` and
 * `audio.listen` (local whisper.cpp; the one-time model download is an
 * approved `http` fetch that carries no content), `canvas.render` (drawn
 * locally), the office tools (`os.fs.docx`, `os.fs.xlsx`,
 * `os.fs.write_pptx`, read-scope and read-taint targets like any file).
 */

export const EGRESS_NOT_ALLOWED_CODE = "ATOMIC_AGENT_EGRESS_NOT_ALLOWED";

export interface EgressTarget {
  readonly cls: EgressClass;
}

export interface EgressClassifierDeps {
  /**
   * The class of the MCP server behind an MCP tool or meta-tool call:
   * `null` for a stdio server marked `local: true`, `"composio"` or
   * `mcp:<server>` for any other, `undefined` when it cannot tell (then a tool named
   * `mcp.<server>.<tool>` counts as `mcp:<server>`: fail closed).
   */
  mcpEgress?: (tool: string, args: Record<string, unknown>) => EgressClass | null | undefined;
  /**
   * The stdio server behind an MCP call that is classed only because it
   * lacks `local: true` (issue #60), so the refusal can offer that fix;
   * `undefined` otherwise.
   */
  mcpUnmarkedStdio?: (tool: string, args: Record<string, unknown>) => string | undefined;
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
  if (tool === "os.web.fetch" || tool === "os.web.crawl") return isLocalUrl(args.url) ? null : { cls: "web" };
  if (tool === "os.http.request") return isLocalUrl(args.url) ? null : { cls: "http" };
  if (tool.startsWith("browser.")) return { cls: "browser" };
  if (tool === VERIFY_TOOL && args.kind === "page") return { cls: "browser" };
  if (tool === "video.render_html") return { cls: "browser" };
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

/** The class one step of `os.web.fetch`'s bot-wall ladder sends through (see the inventory above). */
export function webFetchStepEgress(via: "browser" | "jina" | "firecrawl"): EgressClass {
  return via === "browser" ? "browser" : "http";
}

/** A tool call refused because the folder's constraint does not allow its egress class. */
export class EgressNotAllowedError extends Error {
  readonly code = EGRESS_NOT_ALLOWED_CODE;
  readonly tool: string;
  readonly egressClass: EgressClass;
  readonly policyKey: string;

  /** `localServer`: a stdio MCP server that `local: true` would also let through (issue #60). */
  constructor(tool: string, cls: EgressClass, policy: ProviderPolicy, localServer?: string) {
    const localFix = localServer === undefined
      ? ""
      : `, or, if that server never uses the network, set "local": true on its mcp.servers entry ${JSON.stringify(localServer)} in config.json`;
    super(
      `folder ${policy.key} is restricted: ${tool} would send content off this machine; ` +
      `add ${JSON.stringify(cls)} to projects.constraints[${JSON.stringify(policy.key)}].allowedEgress to allow it${localFix}`,
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
      if (policy === undefined) return null;
      if (shell.cls === null || !policy.allowsEgress(shell.cls)) return new ShellNetworkNotAllowedError(tool, shell, policy);
      // An allowed client does not settle the call: a page probe it
      // serves is still a browser.
    }
    const target = egressTargetOf(tool, args, deps);
    if (target === null) return null;
    const policy = deps.policyForSession(ctx.sessionId);
    if (policy === undefined || policy.allowsEgress(target.cls)) return null;
    const localServer = target.cls.startsWith("mcp:") ? deps.mcpUnmarkedStdio?.(tool, args) : undefined;
    return new EgressNotAllowedError(tool, target.cls, policy, localServer);
  };
}
