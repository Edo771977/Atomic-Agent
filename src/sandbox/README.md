# Command execution

Status: current
Owner: src/sandbox/

Owns command jobs, output caps and process-tree cancellation. Preserve shell interpretation and explicit cancellation; dispatch approval lives in the caller wrapper.

Entry point: [command-runner.ts](command-runner.ts).

Windows internal executables use [windows-system-executable.ts](windows-system-executable.ts): `taskkill.exe` and the command-interpreter fallback are addressed by absolute host `SystemRoot`/`windir` paths under `System32`, never by a cwd/PATH search. Relative or absent OS roots fall back to the absolute standard Windows location; an unavailable executable keeps the existing error/direct-child fallback. A fully qualified explicit `ComSpec` remains configurable, but command/checker environment overrides cannot choose the OS root used by the fallback.

[command-env.ts](command-env.ts) builds the environment of an agent-run command: the agent's own environment minus secret-looking variables (names with KEY, TOKEN, SECRET, PASSWORD and similar, plus a list of known provider keys), with an explicit passthrough list (ATO-347). Git's `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_i` / `GIT_CONFIG_VALUE_i` set is filtered as a unit: entries carrying a credential (`http.*extraheader`, `credential.*helper`, a URL with a password) are dropped and the rest renumbered, so git never sees a count without its keys. It is a deny filter rather than the MCP allowlist because a shell command needs the user's full toolchain environment. `os.shell.run`, `os.git.*`, hooks and skill scripts call it with the configured passthrough. It is also the default of `runCommand` and `startCommandJob` (ATO-175): a caller that passes no `env` (ripgrep, trash, process list/kill, curl, window scripts, capability probes) gets the filtered environment, never the raw `process.env`. A child that really needs a key gets an `env` built and passed explicitly by its caller: the subscription CLIs (`cli-child-env.ts`) and `gh auth token` do this. Read the root instruction route and the underlying domain instructions before cross-domain changes.

[command-toolchain-env.ts](command-toolchain-env.ts) adds, for `os.shell.run` only and after the filter, fixed non-interactive switches and the user's toolchain PATH (macOS `/etc/paths`, Homebrew, nvm, pyenv and similar folders that exist; never the login shell, whose rc files the agent can write), appended after the inherited PATH so nothing already found is shadowed (ATO-1252). It reads no variable back from the agent's environment except PATH.

[os-sandbox.ts](os-sandbox.ts) applies the OS sandbox to shell jobs and verification command processes. Set `ATOMIC_AGENT_SANDBOX=workspace` to enable it or `off` to disable it. Linux uses Bubblewrap with a private PID namespace and procfs. macOS uses a parameterized Seatbelt profile and keeps its host loopback available. Windows x64 uses the native LPAC launcher with a kill-on-close Job Object. A requested sandbox that fails to start never reruns the command without confinement.

[windows-sandbox.ts](windows-sandbox.ts) resolves the helper from the CLI installation, uses an owner-only state directory for launch requests and grants a project-specific SID only after an operator confirms in the TUI. Native DACL verification and the positive and negative policy probes run before every command. The Windows implementation denies networking, including one-time consent. The [native helper guide](../../native/windows-sandbox-helper/README.md) documents the Windows build and fixtures.

The working directory and temporary directories are writable. A command-supplied `cwd` adds no permissions. The state directory and known credential locations are hidden. On Linux, the available mounts also limit ordinary reads. OS permissions and the dispatch read scope still apply. See the user guide for the Linux mount list and coverage of local and directory-service homes. Linux blocks direct IP access to the host and the outside network when isolated. Pathname Unix sockets on Linux and process metadata on macOS have separate security boundaries.

On Linux, Safe Mode starts an asynchronous read of the system trees during runtime startup to warm the kernel filesystem cache. Each launch still scans the current mounts, socket masks and workspace Git metadata. If inventory exhausts its 30-second budget, Safe Mode reports the slow phase and refuses the command. A single blocked filesystem call may run past that deadline.

For activation, one-time network consent and service verification limits, see the [user guide](../../docs/user/os-sandbox.md).

Checks: `npx vitest run src/sandbox` when tests are present; `npm run lint`; `npm run docs:check`.
