# W3.1: Core install diagnostics and diffusion idle lifetime

Status: current
Owner: repository maintainers

Base: origin/main `54f81900b`, fetched on 28 November 2026. Separate checkout and branch from W2 and W3.2. Imports: `b616968dcc542a5323c615250077642063aa4019` (#1777), then `c2fa684d2717cbdaad61f227b2021537bf00ba49` (#1798), each through cherry-pick -x, one commit per upstream commit.

## Fork adaptations

The install conflict auto-merged around the fork's offline guard, which remains intact. The upstream error detail embedded execFile.message and retained the raw cause. The fork instead reads only structured OS fields and produces fixed text: missing binary, execution denied, wrong architecture, failed/missing library, occupied port or early exit. A deadline expiry retains its own fixed timeout code. Unknown OS shapes use early exit, never arbitrary text. Architecture and port get explicit fixed codes. No stderr line is copied, so no process text needs to cross a redaction boundary. Neither the error's public info nor its cause retains the private path or sentinel. Analytics is tested through captureLocalEngineFailed and receives only fixed fields.

The execFile timeout (15 seconds), capture bound (4096 bytes) and hidden Windows launch are pinned by the install test. No engine wait/recovery code, LocalEngineDownError, worker runner, profile, external llama probe, crawl, tool-name or export implementation changes.

Idle retirement follows upstream: a loaded named diffusion model keeps Core running and Agent releases its lease. Unloaded/absent diffusion still permits shutdown. There is no retained diffusion marker or cached process state. The added real-process fixture exercises authenticated HTTP through CoreControlClient, verifies the lease release, actual process survival/exit and startup-marker removal after actual process death. It is a disposable Node control-protocol fixture, not a real Core/model installation or a Studio end-to-end run.

## Test-first evidence

Before importing production changes, the upstream tests fail on main: the loaded diffusion Core is wrongly retired, diffusionModelLoaded is absent, and the spawn classifier cannot be imported. After #1777 but before the fork adaptation, ten diagnostic/privacy tests fail, including the private path/sentinel retained in the error. The adapted spawn tests pass. A separate main-only install control imports no new classifier and fails all 12 install/privacy cases on the old generic reason and raw error text.

The real-process tests were also run with core-idle.ts temporarily restored to main: two fail (loaded Core is stopped, including the death/marker scenario), two idle/404 controls pass. The source was restored before validation.

Seven contract files pass: 85 tests covering spawn classification/privacy, diffusion idle lifetime, detached process handles, startup markers, engine recovery ceilings/LocalEngineDownError and the B7b3 absence contract. Existing recovery tests include the 90-second no-process ceiling; the external probe remains absent.

## Validation

npm ci, npm run lint, npm run imports:check and npm run typecheck:tests pass on Node 26.13.1. The type checker retains 669 explicit existing diagnostics, with no new errors. npm run docs:check and npm run quarantine:check also pass. Checks needing local processes/network were run with normal host access: restricted-environment EACCES runs are failed setup attempts, not passing tests. Existing skips are not counted as green.

The exact required command `npx vitest run src/local-llm src/memory/voting src/tui src/tools/verify` completed with 615 passing files, 3 failing files and 2 skipped files: 7239 passed tests, 3 failed tests and 42 existing skips (7284 total). It is **not green**. The three failures are:

- core-contract: the directory symlink fixture fails with EPERM on this Windows host.
- backend-installer-stable-repo: the Linux shared-library symlink assertion fails on Windows.
- vote-store: the existing 1000-row bulk test exceeds its timer under disk load; this branch intentionally does not include the separate W3.2 test port.

A dedicated origin/main checkout reproduces the same three failing test names in those files: 37 pass, 3 fail. There are no additional candidate failures. No skip or quarantine was added. Full-suite JSON and failed negative controls were retained locally; neither failed nor skipped checks are presented as passing.
