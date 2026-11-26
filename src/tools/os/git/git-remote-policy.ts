import { authorizeGitPolicyMutation } from "./git-mutation-approval.js";
import { resolveUserPath } from "../expand-home.js";
import { activePolicy } from "../../../policy/policy-active.js";
import { requirePolicyWebUrl } from "../../../policy/policy-web.js";
import { policyCallAsks } from "../../../policy/policy-enforce.js";
import { compressToolResult, type CompressedToolResult } from "../../../compressor/result-compressor.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import {
  buildCredentialInjection,
  readGithubToken,
  redactSecret,
  sshBatchEnv,
} from "./git-credentials.js";
import {
  GIT_FAILURE_SUMMARY_CHARS,
  GIT_FAILURE_TAIL_LINES,
} from "./git-error-result.js";
import { runGit, type GitRunOptions, type GitRunResult } from "./git-runner.js";
import type { UrlDataGuardMode } from "../../../config/index.js";
import { checkUrlSend, DEFAULT_URL_DATA_GUARD, requireUrlSendApproval } from "../web/url-data-guard.js";

/**
 * What every network git tool is built with. The remote-sync switch is a
 * predicate, injected by the bootstrap from `config.git.remoteSync`, so a
 * toggle in the Integrations hub is honoured on the next call; the tools
 * never read config. `env` is where the GitHub token is read from.
 */
export interface GitRemoteToolOptions extends DangerousToolOptions {
  isRemoteSyncEnabled: () => boolean;
  env?: NodeJS.ProcessEnv;
  urlDataGuard?: UrlDataGuardMode;
}

export const REMOTE_SYNC_OFF_MESSAGE =
  "remote sync is off — this repository stays on this machine. Nothing was sent or fetched. The operator can turn it on under Integrations → GitHub → Remote sync; do not look for another way to reach the remote.";

/**
 * What the remote-sync refusal is compressed with. The message is fixed
 * text: 208 characters plus the tool name, so at 221 for `os.git.push`
 * it still fits under the compressor's default 400 — this is the one
 * refusal of the set that is not clipped today. It is pinned anyway
 * because the clause that survives last is the one that matters, "the
 * operator can turn it on under Integrations → GitHub → Remote sync; do
 * not look for another way to reach the remote", and two more sentences
 * of wording would silently take it away.
 */
export const REMOTE_SYNC_OFF_SUMMARY_CHARS = 500;

/**
 * The closed-repository check. Runs before any approval prompt and
 * before git is spawned: a structured error the model can read, never
 * a thrown exception, so the turn continues with the operator's answer.
 */
export function refuseWhenRemoteSyncOff(
  tool: string,
  options: GitRemoteToolOptions,
  details: Record<string, unknown> = {},
): CompressedToolResult | null {
  if (options.isRemoteSyncEnabled()) return null;
  return compressToolResult(
    {
      tool,
      status: "error",
      output: `${tool}: ${REMOTE_SYNC_OFF_MESSAGE}`,
      details: { ...details, remoteSync: false, refused: true },
    },
    { maxSummaryLength: REMOTE_SYNC_OFF_SUMMARY_CHARS },
  );
}

export interface GitRemoteApprovalRequest {
  sessionId: string;
  tool: string;
  reason: string;
  preview: string;
  affectedResources: string[];
}

/** One funnel for every network verb: category `git_remote`, always. */
export async function requireGitRemoteApproval(
  options: DangerousToolOptions & { urlDataGuard?: UrlDataGuardMode },
  request: GitRemoteApprovalRequest,
  signal: AbortSignal,
): Promise<void> {
  for (const url of request.affectedResources.filter(value => /^https?:\/\//i.test(value))) {
    await requirePolicyWebUrl(options, request.tool, url, { sessionId: request.sessionId, signal });
    await requireUrlSendApproval(options, { mode: options.urlDataGuard ?? DEFAULT_URL_DATA_GUARD, tool: request.tool, url, sessionId: request.sessionId, signal });
  }
  await requireApproval(
    options,
    {
      sessionId: request.sessionId,
      tool: request.tool,
      category: "git_remote",
      reason: request.reason,
      preview: request.preview,
      affectedResources: request.affectedResources,
    },
    signal,
  );
}

/**
 * Run a network git verb with the token (if any) injected for
 * github.com only, SSH in batch mode, and every byte of output scrubbed
 * of the token before it can reach the transcript or the trace.
 */
export async function runGitRemote(
  options: GitRemoteToolOptions,
  run: Omit<GitRunOptions, "env"> & { sessionId?: string },
): Promise<GitRunResult> {
  const verb = run.args[0];
  if (verb === "clone" || verb === "fetch" || verb === "pull") {
    const root = resolveUserPath(verb === "clone" ? run.args.at(-1)! : run.repo ?? run.workingDir, run.workingDir);
    await authorizeGitPolicyMutation(options, `os.git.${verb}`, root, verb === "clone" || verb === "pull" ? [root] : [], run);
  }
  if (activePolicy().rules.some(rule => rule.action === "webfetch" && rule.effect !== "allow") || (options.urlDataGuard ?? DEFAULT_URL_DATA_GUARD) !== "off") {
    const urls = await remotePolicyUrls(run);
    for (const url of urls.filter(value => /^https?:\/\//i.test(value))) {
      const sessionId = run.sessionId ?? "git-no-session";
      const mode = options.urlDataGuard ?? DEFAULT_URL_DATA_GUARD;
      if (run.sessionId === undefined && (policyCallAsks(activePolicy(), "os.web.fetch", { url }) || checkUrlSend(mode, url, sessionId) !== null)) throw new Error("Git destination approval requires a session context");
      await requirePolicyWebUrl(options, `os.git.${run.args[0]}`, url, { sessionId, signal: run.signal, workingDir: run.workingDir });
      await requireUrlSendApproval(options, { mode, tool: `os.git.${run.args[0]}`, url, sessionId, signal: run.signal });
    }
  }
  const env = options.env ?? process.env;
  const token = readGithubToken(env);
  const injection = buildCredentialInjection(token);
  const result = await runGit({
    ...run,
    args: [...injection.args, ...run.args],
    env: { ...sshBatchEnv(env), ...injection.env },
  });
  return {
    ...result,
    stdout: redactSecret(result.stdout, token),
    stderr: redactSecret(result.stderr, token),
    // `args` echo the helper string, not the token, but scrub anyway.
    args: result.args.map((a) => redactSecret(a, token)),
  };
}

/**
 * Git's non-zero exit as a structured error result, output scrubbed
 * already. Compressed on the same terms as the local write verbs: a
 * rejected push is a list too ("hint: Updates were rejected because the
 * remote contains work that you do not have locally") and the hint that
 * says to integrate the remote changes first comes last.
 */
export function gitFailureResult(
  tool: string,
  result: GitRunResult,
  details: Record<string, unknown>,
): CompressedToolResult {
  const stderr = result.stderr.trim() || result.stdout.trim() || "(no output)";
  const why = result.timedOut
    ? `git timed out after ${result.durationMs}ms`
    : `git exited with ${result.exitCode}`;
  return compressToolResult(
    {
      tool,
      status: "error",
      output: `${tool}: ${why}\n${stderr}`,
      details: { ...details, exitCode: result.exitCode, timedOut: result.timedOut },
    },
    {
      maxSummaryLength: GIT_FAILURE_SUMMARY_CHARS,
      maxTailLines: GIT_FAILURE_TAIL_LINES,
    },
  );
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Read-only URL resolution, including configured insteadOf rewrites, never a network probe. */
async function remotePolicyUrls(run: Omit<GitRunOptions, "env">): Promise<string[]> {
  const inspect = async (args: string[]): Promise<string[]> => {
    const result = await runGit({ ...run, args });
    if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error("Cannot inspect complete Git destinations for organization policy");
    return result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  };
  const verb = run.args[0];
  if (verb === "clone") {
    const at = run.args.indexOf("--");
    const url = at === -1 ? undefined : run.args[at + 1];
    if (url === undefined) throw new Error("Cannot inspect Git clone destination for organization policy");
    return inspect(["ls-remote", "--get-url", "--", url]);
  }
  if (verb !== "fetch" && verb !== "pull") return [];
  const remotes = run.args.includes("--all") ? await inspect(["remote"]) : [run.args.find((arg, index) => index > 0 && !arg.startsWith("-")) ?? "origin"];
  const urls: string[] = [];
  for (const remote of remotes) {
    if (/^https?:\/\//i.test(remote)) urls.push(...await inspect(["ls-remote", "--get-url", "--", remote]));
    else urls.push(...await inspect(["remote", "get-url", "--all", remote]));
  }
  return [...new Set(urls)];
}
