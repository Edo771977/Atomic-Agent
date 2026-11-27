# B6a: defer the Hermes Python plugin bridge (#1639)

Status: current
Owner: docs/reviews/

Deferred in [fork PR #272](https://github.com/Edo771977/Atomic-Agent/pull/272). No production changes. Baseline: fork `origin/main` at `904476e2e099903833223beb4a0ace08b8d7a220`, fetched on 27 November 2026. Origin is `https://github.com/Edo771977/Atomic-Agent.git`; upstream is `https://github.com/AtomicBot-ai/atomic-agent.git`. [Commit inventory](b6a-upstream-commits.json): `348ae04fd`, then `ed2c6903b`, matching the branch row in the triage. B1 PR #246 was open and unmerged; `src/policy/README.md` is absent on this baseline. No policy implementation is assumed.

## Reproduced failures

[Candidate tests](b6a-candidate-tests.patch) were written before importing candidate code. On main they fail to load the missing bridge module. Both upstream commits were then cherry-picked with `-x` in an unpublished, disposable audit branch, one commit each. They applied without conflicts. The published deferral branch contains neither commit. A second run using the exact final upstream leaf files, as in the reproduction script, gives the same results: **4 controls pass, 12 assertions fail, 1 symlink case is skipped on Windows**. [Named results](b6a-candidate-results.json).

- `HermesImporter.run` persists an enabled MCP entry from a CLI trust string, without a TUI decision. The same direct importer path persists it with `ATOMIC_AGENT_TOOL_CHILD=1`. This proves the importer lacks the required guard; it is not a claim about bypassing every CLI bootstrap check.
- After import, replacing `__init__.py` with a harmless fixture that writes a temporary marker causes that marker to be written when the actual shim starts. The protocol initialize response is also checked, so a broken interpreter cannot masquerade as a security refusal. No tool call, model, personal data or remote request is involved. Trust is not tied to the executed content and top-level code runs before tool approval.
- With the child marker set, `installHermesShim` overwrites the installed shim. Its destination is also outside the fork's trust-write inventory. These are direct writer/inventory proofs, not a claim that arbitrary same-user Python can be contained by a marker.
- The real shared `buildMcpStdioEnv` strips inherited synthetic serve/policy secrets but also drops the child marker. This missing marker already exists on main; it becomes a blocker for enabling this new executable surface. Server-configured env overrides and the shim's own `.env` loader need separate review.
- All three interpreter defaults are bare command names (`python3`, or `python` on Windows), not a fixed trusted executable. No attacker program was executed to test PATH search.
- A trust string for a folder key resolves in a different Hermes home as well. The test exercises the resolver's unbound identity; the importer does not itself store and later replay a separate trust registry.
- `category/../safe` and `SAFE` can be author-chosen manifest aliases for another folder. These strings are not canonicalized as filesystem identities: exact folder matching misses and the manifest fallback grants trust to the other plugin. This is identity confusion, not a demonstrated filesystem traversal.

The positive controls verify that no trust string installs no plugin, exact folder keys win over a competing manifest name, ambiguous manifest names bridge nothing, and the entry retains default approval while inherited provider keys are scrubbed. `ed2c6903b` improves these cases but does not supply content-bound operator trust.

Windows cannot create the file symlink used by the escape fixture here (`EPERM`, even outside the restricted runner). The final test skips that case on win32 and keeps the POSIX fixture in the patch. **No successful symlink security assertion is claimed.** The static code follows `existsSync`/file reads for `__init__.py`, without a containment check; this still needs an actual POSIX adversarial run before an import.

## Reproduction

Use a disposable checkout of this PR, containing the two upstream objects, and run `npm ci`, then `python docs/reviews/b6a-reproduce.py`. The script applies the test patch, records the missing-module run, copies exactly four files from `ed2c6903b`, and reruns the tests with the caller's absolute Python interpreter. It deliberately exits nonzero on the security failures. It does not wire CLI/bootstrap, change the MCP client, install dependencies, or make network requests. The production shim runs only the synthetic local plugin.

The shipped absence regression is `src/import/hermes/b6a-hermes-bridge-deferred.test.ts`. Its caller-trust, missing-files and packaging assertions also fail with the candidate present; the preset/include control already passes upstream and is not advertised as a new RED. The executable shim and CLI trust flag remain absent from the shipped artifact. This regression prevents activation; it does not certify an enabled bridge.

## Requirements before reopening

| Boundary | Required implementation and behavioral test |
| --- | --- |
| Operator trust | TUI-only confirmation under the learned/project skill rules (#201); import never grants trust. Child processes cannot create confirmations. |
| Content identity | Pin all executable plugin files and the shim to verified content; a change returns to pending. Bind trust to canonical root and content, testing symlink files/directories, `..`, case aliases and same-name plugins in distinct homes. Address check-to-execution races. |
| Writes | Protect plugin sources and installed shim through the fork's mutation and sandbox inventories, including external plugin paths. Test child write, replacement and deletion paths, not just a writer helper. |
| Environment/interpreter | Use the shared scrubbed MCP environment with an unavoidable child marker and no inherited serve key or policy URL. Review explicitly configured env and `requires_env` loading. Resolve Python predictably without project-controlled PATH. |
| Packaging | Keep the bundled stdlib shim in npm and `scripts/package-bundle.ts` without any new installation script. Existing upstream packaging changes alone do not close execution trust. |
| Sandbox/egress | When enabled, use the fork wrapper with closed network unless explicitly authorized hosts pass folder egress, offline and policy. B6b remains deferred; an enabled bridge must not bypass that prerequisite. |
| Policy | After B1 merges, check the allowed MCP command identity, not only a server name; a same-name replacement must fail. |

Main's sandbox applies to commands/verification, not MCP stdio. Linux uses private PID/procfs and mounts; macOS **already has Seatbelt**, with loopback retained; Windows has no backend. No kernel confinement, real npx/uvx startup or denied-host execution is claimed in this review. The deferral changes no production code or dependency, preserving each platform's actual main behavior.

## Verification

The final check counts and comparison by test name are recorded in [verification](b6a-verification.json). Windows, Node v26.13.1, npm 11.20.0. Native Linux/macOS isolation requires execution on those hosts before reopening. No upstream commit is published: `cherry-pick -x` and separate adaptation commits apply when the bridge can safely be enabled.

<!-- B6 final verification -->
Required focused suite: **7937 passed, 149 failed, 584 skipped**. Main full: **30569 passed, 160 failed, 658 skipped**. Comparing file and full test name gives **27 additional focused failure names**; the JSON preserves every name and suite error. All 4 new absence tests pass. `npm ci`, lint, import boundaries, test typechecking and docs checks pass. Test typechecking retains the existing 674 explicit debt diagnostics with no new error or allowance. Paired isolated follow-up of 27 initially additional names (passed/failed/pending/missing): main **27/0/0/0**, PR **27/0/0/0**; **0 PR-only failures** and **0 unexecuted targets**.
