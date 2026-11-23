import { readOsSandboxSettings } from "./os-sandbox.js";

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
