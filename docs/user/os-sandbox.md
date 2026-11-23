# OS sandbox for agent commands

Status: current
Owner: docs/user/

Launch the agent with `ATOMIC_AGENT_SANDBOX=workspace` to isolate shell commands and their descendants, including background jobs. Verification commands use the same isolation. Use `ATOMIC_AGENT_SANDBOX=off` to run with the ordinary tool approvals and project policy. The sandbox is off by default. Automatic activation is deferred pending real compatibility tests on Linux and macOS.

On Linux, install Bubblewrap through the system package manager and use a host that permits its namespaces and mounts. The agent uses a system-managed executable. An installed binary can still fail in a container or under host user-namespace restrictions. macOS requires an operational `/usr/bin/sandbox-exec`. Windows has no supported backend. If isolation is requested and the backend cannot start, the command fails and is never retried without the wrapper.

- Native dynamic-loader overrides are stripped before starting the sandbox backend.
- Writes are confined to the trusted working directory and temporary directories. A tool argument cannot grant a new write root.
- The agent state directory and known credential paths are hidden, including the managed model server key when its directory is configured separately. Keep application and provider secrets out of project files and other locations readable by the child.
- On Linux, the private PID namespace keeps host process environment and arguments out of the child’s procfs. macOS does not provide the equivalent process-visibility guarantee.
- Outbound IP access is disabled by default. Linux also isolates host loopback and masks known SSH-agent and container-engine sockets. Other pathname Unix sockets have a separate boundary. macOS preserves loopback and denies outbound Unix socket connections when networking is off.
- To permit one shell command to use the network, launch the agent with `ATOMIC_AGENT_SANDBOX_NETWORK=on`, request `network: true` for that command and approve the one-time prompt. Offline mode and restricted project egress still block this exception. The approved process and its descendants get general connectivity. URL consent checks still apply to URLs recognized at dispatch.
- On Linux, service verification performs readiness and HTTP checks inside the same private network as the service. Host-browser checks that launch a page server cannot reach that private network and fail explicitly.

The sandbox covers command processes on these entry points. Project rules, approvals and read scope continue to govern dispatch. Browser, HTTP, Git tools, skill scripts, hooks and stdio MCP have their own execution paths.

Linux requires a user namespace and removal of all capabilities, including when the agent runs as root. If Bubblewrap cannot apply either restriction, the command fails.

On a real Mac, validate profile compilation and exercise synthetic Apple Events, pasteboard reads, Mach lookups and Unix sockets with networking both off and approved. Confirm local service verification and npm and Git still work.

With Safe Mode active, linked node_modules and .git from a verification copy remain read-only on Linux. Command and service goal checks that need external network access can fail because their executors keep networking disabled.

A one-time shell network grant exposes host loopback services as well as external networks. On Linux sharing the network namespace also exposes abstract Unix sockets. An attached browser Chromium DevTools Protocol (CDP) listener on loopback is reachable with this grant. Isolating CDP separately would require a filtered network namespace or a trusted proxy that excludes the endpoint. Keep the grant off for a session that depends on CDP remaining private to the host.

The host home directory is hidden. The trusted project and the running Node executable directory are exceptions. Node's directory is read-only. Git uses the remaining system and repository configuration subject to the Git execution safeguards. Host user Git configuration and credential files stay hidden. Linux temporary storage is private to the command.
