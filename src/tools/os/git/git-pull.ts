import { needsGitPolicyPlan, gitPlanPaths } from "./git-policy-plan.js";
import { authorizeGitPolicyMutation } from "./git-mutation-approval.js";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import {
  NO_PROGRESS,
  PULL_REPORT_LIMITS,
  shapePullReport,
} from "./git-remote-report.js";
import {
  gitFailureResult,
  optionalString,
  refuseWhenRemoteSyncOff,
  requireGitRemoteApproval,
  runGitRemote,
  type GitRemoteToolOptions,
} from "./git-remote-policy.js";
import { requireGitSuccess, runGit } from "./git-runner.js";

const TOOL = "os.git.pull";
const NETWORK_TIMEOUT_MS = 120_000;

/**
 * Fetch and integrate. Fast-forward only by default: a merge commit the
 * operator never asked for is the classic surprise of an unattended
 * pull, and a conflicted rebase parks the tree in a state the model has
 * to be told about. `rebase: true` opts into `--rebase` explicitly.
 */
export function buildOsGitPullTool(
  options: GitRemoteToolOptions,
): ToolDefinition {
  return {
    name: TOOL,
    description:
      "Pull from a remote branch (default: the current branch's upstream on origin). Fast-forward only unless `rebase: true`. Needs Remote sync on; asks for approval.",
    readonly: false,
    async run(rawArgs, ctx) {
      const repo = optionalString(rawArgs.repo);
      const remote = optionalString(rawArgs.remote) ?? "origin";
      const branch = optionalString(rawArgs.branch);
      const rebase = rawArgs.rebase === true;
      const refused = refuseWhenRemoteSyncOff(TOOL, options, { remote, branch });
      if (refused) return refused;

      const root = await runGit({
        repo,
        workingDir: ctx.workingDir,
        args: ["rev-parse", "--show-toplevel"],
        signal: ctx.signal,
        timeoutMs: 5_000,
      });
      requireGitSuccess(TOOL, root);
      const repoRoot = root.stdout.trim();
      const args = [
        "pull",
        NO_PROGRESS,
        rebase ? "--rebase" : "--ff-only",
        remote,
      ];
      if (branch) args.push(branch);
      const preview = `git ${args.join(" ")}`;
      await requireGitRemoteApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: TOOL,
          reason: `pull ${remote}${branch ? ` ${branch}` : ""} into ${repoRoot}`,
          preview,
          affectedResources: [repoRoot],
        },
        ctx.signal,
      );
      let result;
      if (needsGitPolicyPlan(repoRoot)) {
        // Fetch writes metadata only. Its URL/data approvals stay in runGitRemote.
        const fetched = await runGitRemote(options, { sessionId: ctx.sessionId, repo: repoRoot, workingDir: ctx.workingDir,
          args: ["fetch", NO_PROGRESS, remote, ...(branch ? [branch] : [])], signal: ctx.signal, timeoutMs: NETWORK_TIMEOUT_MS });
        if (fetched.exitCode !== 0) return gitFailureResult(TOOL, fetched, { remote, branch, rebase, repoRoot });
        const probe = { repo: repoRoot, workingDir: ctx.workingDir, signal: ctx.signal };
        const pinned = await runGit({ ...probe, args: ["rev-parse", "--verify", "FETCH_HEAD^{commit}"] });
        if (pinned.exitCode !== 0 || pinned.timedOut || pinned.truncated || !/^[a-f0-9]{40,64}$/i.test(pinned.stdout.trim())) throw new Error("Cannot pin fetched Git revision for organization policy");
        const revision = pinned.stdout.trim();
        const paths = await gitPlanPaths(probe, repoRoot, ["diff", "--name-only", "--no-renames", "-z", "HEAD", revision, "--"]);
        if (rebase) {
          const history = await runGit({ ...probe, args: ["rev-list", `${revision}..HEAD`] });
          const commits = history.stdout.trim().split(/\r?\n/).filter(Boolean);
          if (history.exitCode !== 0 || history.timedOut || history.truncated || commits.length > 256 || commits.some(commit => !/^[a-f0-9]{40,64}$/i.test(commit))) throw new Error("Cannot inspect complete rebase history for organization policy");
          for (const commit of commits) paths.push(...await gitPlanPaths(probe, repoRoot, ["diff-tree", "--root", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", commit, "--"]));
        }
        await authorizeGitPolicyMutation(options, TOOL, repoRoot, paths, ctx);
        result = await runGit({ ...probe, args: rebase ? ["rebase", revision] : ["merge", "--ff-only", revision], timeoutMs: NETWORK_TIMEOUT_MS });
      } else {
        result = await runGitRemote(options, { sessionId: ctx.sessionId, repo: repoRoot, workingDir: ctx.workingDir, args, signal: ctx.signal, timeoutMs: NETWORK_TIMEOUT_MS });
      }
      if (result.exitCode !== 0) {
        return gitFailureResult(TOOL, result, { remote, branch, rebase, repoRoot });
      }
      return compressToolResult(
        {
          tool: TOOL,
          status: "ok",
          output: `${preview}\n${shapePullReport(result.stdout, result.stderr)}`,
          details: { remote, branch: branch ?? null, rebase, repoRoot },
        },
        PULL_REPORT_LIMITS,
      );
    },
  };
}
