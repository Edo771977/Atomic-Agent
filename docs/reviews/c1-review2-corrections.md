# C1 second review corrections

Status: current
Owner: src/agent-profiles/

This supersedes first-review point 2 in PR #298. A person-authored restricted profile must not silently become an unrestricted settings or plugin copy. Main c9aaeedadad412242b00ed230da369ffb7223f81 is merged in 21af7f860a6a903926389f0f4466553cf63b8a73 before these changes. The two problems have separate commits.

## 1. Rejected names and visible warnings

Commit db7982fad413f7e26080910818423edd1db80a6f restores rejectedNames reservation across every lower-priority candidate, including built-ins. Tool-admission diagnostics now identify the profile, source/file and offending tool. fusion.delegate returns those warnings in its visible output and details.profileWarnings, as well as the operator log. They remain visible when a different valid profile runs. A task naming a rejected profile fails with unknown-profile before worker creation.

Before production changes, the three end-to-end examples in fusion-delegate.test.ts fail: unknown no.such.tool in user auditor cannot be replaced by unrestricted settings; forbidden fusion.delegate in user review cannot be replaced by settings; unknown Bogus in user explore cannot be replaced by a plugin. A fourth test fails because an unrelated rejected-profile warning is absent from the successful result. The valid user override control passes. Afterwards all five pass, as does the broader 128-test selection. The earlier 180-test selection has 179 passes and the pre-existing Windows symlink EPERM failure.

## 2. Explicit empty lists

Commit 2534377edd2d188197a03666b4f7ebe79b741ab4 chooses explicit rejection. Config and file parsing preserve an empty selection, including arrays/comma lists normalized from blanks. Admission rejects it, reserves the name and reports empty tools list [] with its source. Missing tools remains a separate choice to inherit normal worker tools. The built-in optional-feature exception still produces a nonempty reply-only allowlist when no tools remain; it cannot become all tools.

Before the code change, six checks fail: three real config-to-delegation cases, config/parser preservation assertions and blank comma normalization. Afterwards the six-file selection passes 174 tests, including generated settings reference verification. The reference is regenerated from the new schema documentation. No per-request grammar, provider rule, approval dispatch or subagent execution surface is changed.

[Before/after evidence](c1-review2-before-after.json) records the actual failing names. The earlier fallback test is replaced by a reservation assertion; the valid person override, browser-disabled research and three browser-enabled built-ins remain covered.

## Required verification

Lint, imports:check, typecheck:tests and docs:check pass. Imports report zero cycles and exceptions; test types retain 667 existing diagnostics with no new allowance. The exact requested command runs without exclusions or longer timeouts:

```powershell
npx vitest run src/agent-profiles src/agent src/runtime src/config src/tools/fusion
```

It completes with 6,754 passed, seven failed and twelve skipped assertions across 467 files, exit 1. The nonzero result is retained. Six failures match by file and complete test name against a fresh main c9aaeedad run of the five relevant platform-sensitive files (93 passed, six failed, one skipped). The [comparison](c1-review2-platform-comparison.json) retains the matching symlink/path failures.

The remaining candidate-integration case, `stages a worktree candidate whose source directory has mode 448`, passes an exact-name rerun on both main and C1 with one worker and unchanged timeout. See the [selection](c1-review2-fusion-selection.json) and [paired result](c1-review2-fusion-comparison.json). No additional unexplained failure remains. All regression tests for the two fixes pass; the three C1e absence tests also pass separately.

The [verification record](c1-review2-verification.json) identifies the tested source, main merge, checks, counts and rerun case. Earlier C1 reports remain evidence for their pinned commits, rather than a claim that this Windows selection is wholly green.
