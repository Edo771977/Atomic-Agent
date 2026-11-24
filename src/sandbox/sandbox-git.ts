import { getConfig, getStateSecretPaths, resolveStateDir } from "../config/index.js";
import { runCommand } from "./command-runner.js";
import { buildOsSandboxEnv, buildOsSandboxPolicy, formatSandboxUnavailable, readOsSandboxSettings, wrapWithOsSandbox } from "./os-sandbox.js";

export function sandboxGitArgs(): string[] {
  return readOsSandboxSettings().mode === "workspace" ? [
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.sshCommand=/dev/null", "-c", "credential.helper=",
    "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false",
    "-c", "gpg.program=/dev/null", "-c", "gpg.ssh.program=/dev/null", "-c", "gpg.x509.program=/dev/null",
  ] : [];
}

export function sandboxGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (readOsSandboxSettings().mode !== "workspace") return env;
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:GIT_SSH(?:_COMMAND|_VARIANT)?|GIT_CONFIG_(?:PARAMETERS|COUNT|KEY_\d+|VALUE_\d+))$/i.test(key)));
}

export function prepareSandboxGit(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  readOnlyWorkspaceRoots: readonly string[] = [],
  workspaceRoots: readonly string[] = [cwd],
): { command: string; args: string[]; env: NodeJS.ProcessEnv; helperCwd?: string } {
  if (readOsSandboxSettings().mode !== "workspace") return { command: "git", args: [...args], env };
  const wrapped = wrapWithOsSandbox("git", args, buildOsSandboxPolicy({
    workspaceRoots, readOnlyWorkspaceRoots, gitMetadataWritable: true,
    stateDir: resolveStateDir(), protectedPaths: getStateSecretPaths(getConfig().paths), network: false,
  }), { cwd, env });
  if (!wrapped.ok) throw new Error(formatSandboxUnavailable(wrapped.reason));
  return { ...wrapped, env: wrapped.helperCwd === undefined ? buildOsSandboxEnv(sandboxGitEnv(env)) : {} };
}

export function runSandboxGit(
  args: readonly string[],
  options: Parameters<typeof runCommand>[2] & { cwd: string; env: NodeJS.ProcessEnv },
  readOnlyWorkspaceRoots?: readonly string[],
  workspaceRoots?: readonly string[],
): ReturnType<typeof runCommand> {
  const launch = prepareSandboxGit(args, options.cwd, options.env, readOnlyWorkspaceRoots, workspaceRoots);
  return runCommand(launch.command, launch.args, { ...options, cwd: launch.helperCwd ?? options.cwd, env: launch.env });
}
