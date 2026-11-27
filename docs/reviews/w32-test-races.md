# W3.2: test race corrections

Status: current
Owner: repository maintainers

Base: origin/main `54f81900b`, fetched on 28 November 2026, independent of W2 and W3.1. No production implementation changes.

## Imported chain and conflict resolutions

Each upstream source commit was imported with git cherry-pick -x, in this order:

1. `f77dd9190a630a81adc195c96c8a48911214e860` (#1778): wait for actual partial-file bytes before pause/cancel and keep the GGUF parked until the projector failure is served. The fork already waited for progress records; the port waits for the stronger disk condition while retaining the model fixtures, actual worker and outcome assertions. The final download file matches #1778 exactly.
2. `7b81eba245e315b277a33a7beaaff504ec89430f` (#1913): bulk vote fixture seeding in one transaction. The fork already pinned the three rail updatedAt values (3000/2000/1000), so those values and its detached-turn/steering coverage are retained. An annotation records that equivalence. Its temporary duplicate download additions are removed in the next commit.
3. `b9a2c234440d9a7fffc159599e85ae0381223586`: removes that duplicate; the download file returns exactly to the #1778 result.
4. `80fc2d3d591e2f1bab5ff8e4c6d56b06a1c5636c`: verify failure diagnostics and port-race handling.
5. `6955b375c31387733cde2fc23e4723fc96a4fd3e`: Vitest 4 options before body, adapted to retain the 30-second timeout and replace unconditional retry:2 with a narrowly scoped helper.

freePort closes its listener before the actual service binds, so another worker can take that port. Only a failed run with the literal EADDRINUSE code in stderrTail starts a new attempt, with a fresh port, at most three attempts total. Every attempt asserts byte-identical workspace contents and removed copies before retrying. Assertion throws are not caught. Other behavior, permission and copy failures return immediately. Helper tests cover the bound, recovery and four non-port failure cases. No quarantine, CI configuration, exclusion, timeout ceiling or dependency changes.

## Negative controls

Each edited behavior remains capable of failing. Temporary inversions were restored after use:

- Download pause: expect cancelled instead of paused; one assertion failure.
- Voting bulk decay: expect 999 changed memories instead of 1000; one assertion failure.
- Rail move: swap the first two expected IDs; one assertion failure.
- Verify service: expect out.ok=false instead of true; one assertion failure, with no assertion retry.
- Port retry helper: stop after two attempts instead of three; one assertion failure (2 versus 3).

The first three ran in the candidate checkout, the final two in a separate checkout using the candidate test file and main production code (production code is identical). Only the selected negative test was run in each control; other tests were not executed and are not counted as passing. The restored files were validated separately.

## Validation

npm ci, npm run lint, npm run imports:check and npm run typecheck:tests pass on Node 26.13.1. Existing test-type debt remains 669 diagnostics; no new debt or quarantine allowance. The restricted-environment verify run failed before behavior on symlink privileges, then passed with normal host access.

The first five-run campaign overlapped the W3.1 whole-area suite and negative-control workers: runs 1-4 passed, run 5 had a 15-second clamp test timeout and a 10-second setup-hook timeout in vote-store. These failed results are retained, not retried by Vitest or presented as green. The fresh serialized campaign and whole-area outcomes follow.

The final campaign ran after the whole-area suites and negative controls had finished, using the exact required `npx vitest run` command on all four edited test files. It completed five consecutive successful commands; each command stops the campaign immediately on nonzero exit. No Vitest retry option is present.

| Run | Passing files | Passing tests | Failed tests | Skipped tests |
| --- | --- | --- | --- | --- |
| 1 | 4 | 69 | 0 | 0 |
| 2 | 4 | 69 | 0 | 0 |
| 3 | 4 | 69 | 0 | 0 |
| 4 | 4 | 69 | 0 | 0 |
| 5 | 4 | 69 | 0 | 0 |

The final repository tree was compared byte-for-byte before and after reconstructing the five upstream commits; source contents were unchanged. The download file's Git blob is `fb77e14670156d55c08d51663a964744348f2555`, exactly the #1778 source blob, including after the #1913 duplicate-removal commit.

The required whole-area command `npx vitest run src/local-llm src/memory/voting src/tui src/tools/verify` completed with 613 passing files, 2 failing files and 2 skipped files: 7212 passing tests, 2 failed tests and 42 existing skips (7256 total). It is **not green**. The two failures are the core-contract directory symlink (EPERM) and the backend-installer-stable-repo Linux shared-library symlink assertion. Both are reproduced by name on origin/main in the dedicated baseline checkout. vote-store and all four edited files pass in this whole-area run. No new failing name appears. Skipped tests are not counted as passing.

npm run docs:check and npm run quarantine:check pass. Only test files and this series' documentation change. W3.1 and W3.2 share main `54f81900b` as merge base and neither contains the other's commits. The W2 checkout was not edited.
