# OS sandbox for agent commands

Status: current
Owner: docs/user/

Launch the agent with `ATOMIC_AGENT_SANDBOX=workspace` to isolate shell commands and their descendants, including background jobs. Verification commands use the same isolation. Use `ATOMIC_AGENT_SANDBOX=off` to run with the ordinary tool approvals and project policy. The sandbox is off by default. Automatic activation is deferred pending real compatibility tests on Linux and macOS.

On Linux, install Bubblewrap through the system package manager and use a host that permits its namespaces and mounts. The agent uses a system-managed executable. An installed binary can still fail in a container or under host user-namespace restrictions. macOS requires an operational `/usr/bin/sandbox-exec`. Windows currently refuses commands when Safe Mode is enabled. If isolation is requested and the backend cannot start, the command fails and is never retried without the wrapper.

- Native dynamic-loader overrides are stripped before starting the sandbox backend.
- Writes are confined to the trusted working directory and temporary directories. A tool argument cannot grant a new write root.
- The agent state directory and known credential paths are hidden, including the managed model server key when its directory is configured separately. Keep application and provider secrets out of project files and other locations readable by the child.
- On Linux, the private PID namespace keeps host process environment and arguments out of the child’s procfs. macOS does not provide the equivalent process-visibility guarantee.
- Outbound IP access is disabled by default. Linux also isolates host loopback and masks known SSH-agent and container-engine sockets. The launcher masks pathname Unix sockets found in the mounted trees before starting the command. macOS preserves loopback and denies outbound Unix socket connections when networking is off.
- To permit one shell command to use the network, launch the agent with `ATOMIC_AGENT_SANDBOX_NETWORK=on`, request `network: true` for that command and approve the one-time prompt. Offline mode and restricted project egress still block this exception. The approved process and its descendants get general connectivity. URL consent checks still apply to URLs recognized at dispatch.
- On Linux, service verification performs readiness and HTTP checks inside the same private network as the service. Host-browser checks that launch a page server cannot reach that private network and fail explicitly.

The sandbox covers command processes on these entry points. Project rules, approvals and read scope continue to govern dispatch. Browser, HTTP, Git tools, skill scripts, hooks and stdio MCP have their own execution paths.

Linux requires a user namespace and removal of all capabilities, including when the agent runs as root. If Bubblewrap cannot apply either restriction, the command fails.

On a real Mac, validate profile compilation and exercise synthetic Apple Events, pasteboard reads, Mach lookups and Unix sockets with networking both off and approved. Confirm local service verification and npm and Git still work.

With Safe Mode active, linked node_modules and .git from a verification copy remain read-only on Linux. Command and service goal checks that need external network access can fail because their executors keep networking disabled.

A one-time shell network grant exposes host loopback services as well as external networks. On Linux sharing the network namespace also exposes abstract Unix sockets. An attached browser Chromium DevTools Protocol (CDP) listener on loopback is reachable with this grant. Isolating CDP separately would require a filtered network namespace or a trusted proxy that excludes the endpoint. Keep the grant off for a session that depends on CDP remaining private to the host.

The host home directory is hidden. The trusted project and the running Node executable directory are exceptions. Node's directory is read-only. Git uses repository configuration subject to the Git execution safeguards. Safe Mode imports only the operator’s global Git ignore file, from core.excludesFile or the default XDG location, in read-only form. Fusion freezes those rule bytes in its snapshot. Host user Git configuration and credential files stay hidden. Linux temporary storage is private to the command.

Each sandboxed command gets a distinct tool cache location. Linux removes its contents when the command’s private temporary filesystem is destroyed.

Commands see existing workspace .git metadata as read-only, including config, hooks and info. For linked Git worktrees, the external metadata stays on the read-only host filesystem. The host Git helpers disable fsmonitor, hooks, credential helpers and configurable SSH/GPG programs in Safe Mode. This does not prevent project scripts or IDE configuration from being changed. Host IDEs and LSP servers can still execute code from projects under their own policies.

Linux starts with an empty root and mounts system binaries, libraries, selected shared data (CA certificates, Git, locale, Node, pkg-config, Python, terminfo and timezone), an existing /nix/store, selected public /etc entries (identity and name resolution, loader cache, timezone and public CA certificates), approved toolchains, Node and its colocated npm package, and the authorized workspace. /var, /srv, /mnt, /media, /opt and /usr/local have no blanket mount. An explicitly approved toolchain or workspace can expose a narrower subtree. Unlisted system trees, private SSH and TLS files and account backups stay hidden. /run, /var/run, /run/lock and /var/tmp are private. Only approved networking adds the host resolver file. Workspaces inside agent state are refused. Linux Safe Mode refuses host UID 0 by default. An operator can explicitly opt in with `ATOMIC_AGENT_SANDBOX_ALLOW_ROOT=1`; the agent warns when using that permission. The private procfs is mounted read-only, including the visible sysctl entries.

Linux hides /home, /root and the running account’s home, apart from explicit workspace and toolchain mounts and the Git ignore file. Other absolute login homes listed in the local /etc/passwd file are masked for ordinary login UID ranges. The launcher does not query LDAP or SSSD. An LDAP, SSSD or service-account home outside the mounted trees is absent regardless of how the account is resolved. A home inside an allowed system mount, such as a service home under /usr/lib, can remain readable if it was not identified by the local home masks and host permissions allow it. Use a location outside the allowed trees for private service data.

Linux masks existing filesystem sockets in exposed mount sources, hides group- or world-writable subtrees of the system mounts and hides separate host submounts inherited by system, workspace and toolchain mounts. Live workspace and explicitly approved toolchain trees can still change from the host during execution. A host process that creates a new pathname socket in one of those visible trees after inventory can make it reachable. Keep host services outside those trees. Classical seccomp cannot inspect the sockaddr passed to connect, so it cannot give a pathname or address-family rule that preserves Verify's local networking and relay. Existing network namespace and relay checks still apply.

The active Node installation is available read-only even under the private temporary mount. Operators can declare additional read-only toolchain directories with ATOMIC_AGENT_SANDBOX_TOOLCHAINS, using the platform PATH separator. Entire private roots and their ancestors cannot be reopened this way.
Safe Mode does not import identity from the host Git configuration file. Git commits use the explicit GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL environment values or identity set in the repository. Configure those values explicitly for a commit that needs them.

Safe Mode routes host Git tools and Fusion Git subprocesses through the same OS wrapper and refuses launch if the backend cannot apply it. Git metadata writes by these tools stay within authorized roots. Shell commands protect existing scoped Git metadata, including nested repositories and in-scope separate gitdirs, rediscovered before each launch. Existing node_modules and unreadable subtrees stay read-only during shell jobs. If the scan crosses its directory or mount budget, that workspace stays available read-only to the command. External gitdirs receive no writable mount and can be unavailable under a masked tree. Remote Git tool commands use the offline sandbox policy.

### Linux pathname sockets

Linux Safe Mode inventories and masks existing pathname sockets before launch. An offline command has its own network namespace, which hides host abstract Unix sockets. A host process can still create a pathname socket in an exposed workspace or toolchain directory after launch. Keep host pathname services outside sandbox-visible trees.

The Bubblewrap 0.9 backend has no runtime pathname rule. A classic seccomp filter cannot inspect the address buffer passed to `connect`. Denying the calls needed for all pathname connections would also remove Verify's Unix relay. Landlock's abstract Unix-socket scope does not apply to filesystem socket paths. A future runtime policy needs a kernel and launcher that can mediate filesystem socket destinations and a narrow relay exception, verified independently from `socketpair`.

### Linux session keyring

This backend does not currently isolate the inherited kernel session keyring or independently deny `add_key`, `keyctl` and `request_key`. Host kernel and container policy may already deny them. Safe Mode alone does not make host session keyrings suitable for storing credentials that sandboxed commands must never access. Enforcing this needs a trusted launcher with a verified syscall filter or a verified new session keyring, with coverage for supported Linux architectures.

### Toolchains under /usr/local

A bind of all of `/usr/local` imports unrelated software, configuration and data under that prefix. List only the directories a tool needs, using the separator for your platform. For example, on Linux:

```sh
export ATOMIC_AGENT_SANDBOX_TOOLCHAINS=/usr/local/bin:/usr/local/lib/python3.12
```

The directories must exist on the host. Add a separate library or package directory when the executable refers to it. Safe Mode mounts each approved directory read-only.


## Windows CLI

The Windows backend is gated off. On the hosted Windows runner, an ordinary
Node installation fails inside LPAC before evaluating even an offline script.
Winsock reports error 10107 and the second TCP client fails during COM
initialization. The CLI therefore refuses commands and skips new ACL grants.
The settings and ACL behavior below describe the experimental backend under
test. See the [native helper guide](../../native/windows-sandbox-helper/README.md)
to reproduce the results in disposable fixtures.

To use the backend after it passes the Windows acceptance tests, start the TUI from the project with `ATOMIC_AGENT_SANDBOX=workspace` and an
installed `atomic-sandbox-helper.exe`. On first use, the TUI shows the canonical
project path, an approximate file count and the rights it will add. Approving
adds inheritable NTFS allow entries for a project-specific LPAC SID to the
project and to existing files and directories under it. The project grant
permits reading, writing and execution. Explicitly listed runtime locations
get read and execute access. Existing ACL entries remain in place. The helper
skips reparse points, rejects hard-linked files during a grant, and reports
ACL errors. The host profile, state and system trees remain outside the
writable grant. FAT, exFAT and nonlocal paths are unsupported.

In PowerShell, set your offline runtime directories before opening the TUI.
Use paths where your Windows account can manage ACLs, for example a portable
Git installation and a portable Node executable in a dedicated local folder.
Install the unsigned x64 helper from the Windows sandbox CI artifact or build
it locally. Place it alongside `atomic-agent.exe` for a standalone installation,
or at `native/windows-sandbox-helper/atomic-sandbox-helper.exe` under the
installed Node package. Development builds can use the absolute
`ATOMIC_AGENT_WINDOWS_SANDBOX_HELPER` override. Keep the helper and the
agent installation outside approved writable projects.

```powershell
$env:ATOMIC_AGENT_SANDBOX = 'workspace'
$env:ATOMIC_AGENT_SANDBOX_TOOLCHAINS = 'D:\Tools\Git\ucrt64\bin;D:\Tools\Node\node.exe'
atomic-agent tui
```

To inspect the entries, run `icacls "D:\Projects\example" /T` and look for the
SID recorded in `windows-sandbox/grants.json` under the agent state directory.
Close active sandbox sessions before revoking their ACLs. Run
`atomic-agent sandbox windows revoke "D:\Projects\example"` from your own
terminal, or use `atomic-agent sandbox windows revoke --all`. Turning Safe
Mode off stops sandboxing future commands. The grants remain on disk until the
operator revokes them. Revoke before uninstalling the CLI so the registry and
helper remain available for the operation.

The helper checks ACL coverage and uses a real LPAC process to test an existing
project file, denied state access, denied out-of-project writes and a reachable
loopback listener before each launch. Files copied with their own ACLs can
lose the grant. OneDrive, backup tools or antivirus may also recreate files or
reset ACLs. Reopen the project in the TUI to regrant access. If a registered
root was moved, restore it to its registered path before revoking.

LPAC denies direct IP networking, including external, LAN and loopback
connections. Temporary network consent is unavailable. Commands can still use
container-private storage and approved standard input and output handles. The
Job Object terminates descendants when the helper exits, is cancelled or reaches
its timeout. Windows has no private PID namespace here and some process metadata
may be enumerable. OS-provided IPC endpoints can remain accessible according
to their Windows security descriptors.

Node or npm installed inside the user profile, Store Python, PowerShell
profile modules and commands that require network access may fail. Verify
services that require host networking and Fusion worktrees outside the
approved root can also be refused. Run `git status` and
`node -e "console.log(1)"` from the sandboxed shell to check the local tools.
