# B7a follow-up: exports, refusal tags and startup

Status: current
Owner: docs/reviews/

Follow-up to merged PRs #273, #274 and #277. Dedicated checkout from
`origin/main` **8169861335b28c8c8f65a7b6f0938a23e9f20333**;
origin is `https://github.com/Edo771977/Atomic-Agent.git`, upstream is
`https://github.com/AtomicBot-ai/atomic-agent.git`. No dependency or install-script change.

## Decisions and regression evidence

Each production fix has its own commit, with its regression tests. The PR description
maps the points to the final commit IDs. [Verification](b7a-followup-verification.json)
records counts and the file/full-name comparison against the frozen main.

| Problem | Failing control before the fix | Final regression coverage |
| --- | --- | --- |
| Shared safe export writer | Six failures on original main; nine additional conventional-instruction failures and a synthetic temporary-creation failure observed before their corrections | `src/cli/export-file-safety.test.ts`, `src/session/chat-export-file.test.ts`; CLI/TUI export suites |
| Presentation-equivalent secrets | All 20 sentinel cases fail on original main | `src/session/export-render-redaction.test.ts`: PDF/HTML/DOCX, invisible/fullwidth characters, Markdown escapes, emphasis, inline/block code and PDF final encoding |
| Closed provider types | Seven failures with identifier-shaped arbitrary values | `src/error-reporting/provider-type-vocabulary.test.ts`, `error-scrubber.test.ts`; includes Google array bodies |
| Structured parameter source | Seven failures before switching away from prose | `src/error-reporting/provider-param-source.test.ts`; contradictory prose, absent/non-string params and private map keys |
| TUI option syntax | Four failures before parsing trailing options | `src/tui/commands/export-command.test.ts`; options before/after format/path, unknown option refused |
| CLI tool-child reads | Three failures on original main: export succeeds instead of refusal | `src/cli/export-command.test.ts`; explicit ID, `--last`, PDF/file/force; no session load/list before refusal |
| HTTP rendering bound | Four failures: 10,000 records return 200 instead of 413 | `src/http/route-session-export.test.ts`; all formats and oversized content, plus named-token visibility suite |
| Managed startup ownership | External-mode start creates a marker before the fix | `src/tui/local-models/start-pending-lifecycle.test.ts`; external directory remains absent, managed error/cancellation cleanup. `turn-recovery-local-engine.test.ts` pins pending/no-owner recovery past 8 seconds to `LocalEngineDownError` at 90 seconds |

The pending/no-owner recovery assertion already passes before the TUI mode fix: it
pins the existing fork ceiling and needs no production recovery change.

The writer checks both lexical and canonical destination/directory forms against
state, `getStateSecretPaths`, `getTrustConfigPaths`, conventional policy/instruction and skill paths. Existing
file symlinks and multiple-hardlink files are refused even with force. Exclusive
creation remains `wx`; force uses an adjacent owner-only temporary file and rename.
The inode assertion distinguishes replacement from truncation. Hardlinks and directory
junctions run on this Windows host. Two real file-symlink cases are skipped here because
this account cannot create file symlinks (`EPERM`); they run on non-Windows hosts.
Conventional instruction protection covers AGENT/AGENTS, CLAUDE, GEMINI, Cursor and
Copilot rules as well as policy files. If temporary creation fails, cleanup touches no
unowned file, returns the original failure and leaves the destination unchanged.

The redaction projection conservatively matches compatibility forms, combining marks,
invisible/control characters and Markdown delimiters, replacing original source ranges.
Exact matches retain the shared detector's markers. Known secrets reach each renderer;
PDF also masks joined encoded text before wrapping and code before chunking.

Only the eight requested error types may be reported. Params come from `body.param`.
Provider wording quoting the person can still influence reason classification, whose
result remains in the closed reason vocabulary. Reporting opt-out/offline/incognito gates
are unchanged.

HTTP export rejects over 2,000 transcript records, 1,000,000 UTF-16 units in session
strings/keys, 20,000 visited values or 32 levels before rendering. Visibility and incognito
checks precede this bound. Larger chats remain exportable from the person's terminal.
Every marked CLI tool-child export is refused because this CLI has no authenticated
current-session binding/read scope.

## Reproduction

Final setup/static checks pass: `npm ci`, lint, import boundaries (zero runtime
cycles/exceptions), test typecheck (674 existing debt diagnostics, no new errors)
and documentation checks. No test-type allowance changed.

The final requested suite has **15,143 passed, 29 failed, 59 skipped** across 1,276
files. The frozen main has **15,079 passed, 29 failed, 57 skipped** across 1,271 files.
All 29 failures match by file and full test name; there are **zero additional
failures** and every executable new regression passes. The two added skips are
the Windows file-symlink cases described above. This is not an entirely green suite.
The verified `src` tree is `5ba68369f4a83cd288f739d8cbe770ef369df739`.

The initial extended run exposed two obsolete integration assertions (Google prose
as a parameter source and an unlisted llama type as an external tag). They were
adapted to the requested behavior; the complete suite was rerun on the consolidated
source tree. The verification file retains their initial failing names.

Install with `npm ci`, then run:

```sh
npm run lint
npm run imports:check
npm run typecheck:tests
npm run docs:check
npx vitest run src/session src/tui src/cli src/http src/error-reporting src/llm src/agent/turn src/runtime src/local-llm
```

Run the eight rows' named test files for the focused regression controls. The main
control uses the same commands in a separate detached worktree. Raw local run reports
are summarized in the verification file rather than adding large runner dumps to the PR.
