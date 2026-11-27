# B6b: renew deferral of sandboxed MCP stdio (#1630)

Status: current
Owner: docs/reviews/

Deferred in [fork PR #276](https://github.com/Edo771977/Atomic-Agent/pull/276). No production changes. Baseline: fork `origin/main` at `904476e2e099903833223beb4a0ace08b8d7a220`, fetched on 27 November 2026. Origin is `https://github.com/Edo771977/Atomic-Agent.git`; upstream is `https://github.com/AtomicBot-ai/atomic-agent.git`. [Commit inventory](b6b-upstream-commits.json): `1a959f7e6`, `b40853a56`, `756e34729`, `d9c5044e4`, `aa18421f9`, `4bee18579`. The branch row supplies the chain; the final merge's second parent alone does not. `93c6763d3`, `94768b68f` and merge `1603f5bf8` are excluded. B1 #246 was open and unmerged, and the policy README is absent on this baseline.

## Blocking launch contract

The latest upstream `McpClient.sandboxedSpawn` passes **`network: true` unconditionally** to `buildOsSandboxPolicy`. It does not consume an operator host list, folder egress constraint or offline state. Thus the previous deferral condition, an egress policy enforced on the sandboxed server itself, remains unsatisfied. A tool-argument URL check or `local: true` declaration does not constrain arbitrary code running during initialization or between calls.

[Candidate tests](b6b-candidate-tests.patch) were written first. Main lacks the wrapper: its no-wrapper controls pass and its enabled-wrapper assertions fail. The six MCP commits were then cherry-picked separately with `-x` in a disposable audit branch, retaining fork `local` handling and choosing the fork's sandbox file at every conflict. This is an audit scaffold, **not a functioning port**: the final MCP client expects upstream-only keepReadable/socket options, which the fork wrapper does not implement. The published branch contains no such commits or production adaptation.

The reproducible proof extracts only the exact final MCP client and path helper from `4bee18579`, retaining the fork policy builder. Its results match the scaffold: **3 controls pass, 4 security assertions fail**. [Named results](b6b-candidate-results.json). It verifies the production client's transport-construction boundary without spawning a server. `wrapWithOsSandbox` is replaced by a capturing passthrough, and the missing upstream `MCP_SECRET_HOME_PATHS` export is an empty test-only compatibility value. The real fork policy builder is invoked and its input recorded. This does not simulate or certify kernel isolation.

- With sandbox enabled and network consent false, the actual client requests `network: true`.
- A boolean network switch without explicit authorized hosts still requests unrestricted networking.
- With the real process-wide offline switch on, the client still requests unrestricted networking.
- The client supplies no `protectedPaths` inventory for configured state/trust files outside the state directory.

Controls prove sandbox off leaves the transport unwrapped, sandbox on reaches the wrapper, and explicit per-server opt-out skips it. They establish code paths, not the human provenance of the configuration. That provenance still needs separate child/config mutation tests before enabling exceptions.

## Fork compatibility and outstanding proof

Main's sandbox is optional. Shell and verification use the same Linux private PID/procfs wrapper and protected state mounts. macOS **already uses Seatbelt** and retains host loopback with networking disabled; Windows has no backend. The original task's assumption that macOS has no sandbox is not true of this baseline. The shipped absence regression checks the optional default, builds a macOS wrapper through its documented platform seam and checks the loopback profile; it does not execute Seatbelt on Windows.

| Boundary | Required before an enabled port |
| --- | --- |
| Default and host grants | Closed network by default; explicit operator host grants intersect folder egress, offline and policy. Test an actual server's denied-host connection at startup and after an allowed call, including DNS/redirect/IPv4/IPv6 and offline transitions. A boolean host-network switch is insufficient. |
| Shared confinement | Keep fork PID namespace, procfs, mount inventory and refusal without fallback. Adapt MCP to `src/sandbox/os-sandbox.ts`, never replace it with upstream ATO-469/472. |
| Protected data | Hide state, npmrc, shell rc, Docker and ssh-agent sockets, and both `getStateSecretPaths`/`getTrustConfigPaths` inventories. Strip `SSH_AUTH_SOCK` and unsafe loader env before wrapper startup. Test file and socket access in the real server process. |
| State-installed code | Reopening exact executable code must not reopen its state directory or credentials. `b40853a56`/`756e34729` address this upstream; the fork needs a tested mechanism rather than ignored keepReadable fields. Test symlink escape and changed files. |
| Human exceptions | A per-server bypass and `allowDocker` must be explicit operator decisions which the model cannot persist. Document Docker's root-equivalent host access and test the socket stays hidden otherwise. |
| Compatibility | Real npx and uvx startup within confinement, caches and executable visibility; sandbox-off parity. Keep macOS Seatbelt behavior and Windows's existing unsandboxed MCP behavior explicit, rather than making a requested unavailable wrapper a new regression accidentally. |
| Policy | B1 was not merged. After it merges, enforce MCP command identity and host restrictions in addition to the folder/offline gates. |

No real denied-host, Linux Bubblewrap, macOS Seatbelt, npx/uvx or Docker probe was executed here. All those remain reopening requirements, not passing assertions. The lack of an enforced host policy is enough to renew deferral without installing the surface. Existing stdio servers still run outside the OS command sandbox; this PR introduces no new security guarantee for them.

## Reproduction and absence regression

Use a disposable checkout of this PR with the listed upstream objects and `npm ci`, then run `python docs/reviews/b6b-reproduce.py`. It applies the test patch, records the main boundary run, copies the two final upstream MCP leaves, and reruns. It deliberately exits nonzero on the four security assertions and never starts a child server or opens the network.

`src/mcp/b6b-mcp-sandbox-deferred.test.ts` pins absence of the MCP wrapper/path helper and confirms the parser still discards unsupported sandbox/Docker fields rather than granting them. Those two assertions fail with candidate code present. The platform fixture initially overlapped the protected test state with its writable temp root; it was corrected to use a distinct named state path without writing there. The platform contract is preservation, not a new RED requirement. No dependency, configuration semantics or production source is changed.

## Verification

Final results, including the full test-name comparison with main, are in [verification](b6b-verification.json). Windows, Node v26.13.1, npm 11.20.0. Kernel tests remain for the respective Linux/macOS hosts. No upstream commit is published: the six `-x` commits belong only to the disposable audit, and a future enabled import still requires separate adaptation commits with tests.

<!-- B6 final verification -->
Required focused suite: **7917 passed, 168 failed, 584 skipped**. Main full: **30569 passed, 160 failed, 658 skipped**. Comparing file and full test name gives **46 additional focused failure names**; the JSON preserves every name and suite error. All 3 new absence tests pass. B6b full: **30551 passed, 181 failed, 658 skipped**; **22 additional failure names** against main. `npm ci`, lint, import boundaries, test typechecking and docs checks pass. Test typechecking retains the existing 674 explicit debt diagnostics with no new error or allowance. Paired isolated follow-up of 51 initially additional names (passed/failed/pending/missing): main **50/1/0/0**, PR **51/0/0/0**; **0 PR-only failures** and **0 unexecuted targets**.
