# Verification tools

Status: current
Owner: src/tools/verify/

`verify.syntax` syntax-checks files. `verify.run` runs commands, services and pages against a throwaway copy of the working directory, and checks individual documents and spreadsheets from a file snapshot. It evaluates `checks` on the result. Fusion contract checks are `verify.run` specs run through [`runChecks`](run-verify.ts). Read [tool instructions](../AGENTS.md) and the adjacent tests before changing behavior.

## Entry points

- [verify-run-args.ts](verify-run-args.ts): argument parsing and bounds; errors name the field.
- [run-verify.ts](run-verify.ts): `runVerify` / `runChecks` and the `VerifyRunResult` shape.
- [verify-authorization.ts](verify-authorization.ts): the approval plan, shared by the tool and contract checks; only declared fields pass.
- [verify-checks.ts](verify-checks.ts): the assertion language. An unknown check fails; it never passes.
- [run-page-kind.ts](run-page-kind.ts), [page-game-harness.ts](page-game-harness.ts), [page-screenshots.ts](page-screenshots.ts): the headless page run, its game harness and its screenshots.
- [safe-regex.ts](safe-regex.ts): the regex policy of `matches` checks.

## Documents and spreadsheets

`kind: "document"` and `kind: "spreadsheet"` require a local file `path` relative to the project folder, or relative to `cwd` when supplied. They use the verification approval, read-scope and cancellation rules and take a snapshot of the named file only. Parsing is local. Workbook macros and formulas are never executed. The file limit is 8 MiB, ZIP-based files are limited to 32 MiB uncompressed across at most 1,024 members, and parsing has a maximum duration of 15 seconds. A file beyond these limits produces an `uncheckable` result with a reason.

Results include a readable detail and a `pass`, `fail` or `uncheckable` status. Existing `checks` can match the detail on `stdout` and assert `exit 0` for a passing built-in check. Optional assertions can make a run fail even when the built-in check passed. Both `fail` and `uncheckable` make the run unsuccessful.

- `document` accepts `.docx`, `.md`, `.pdf` and `.txt`. Optional `requiredSections` lists required headings. Word and Markdown use styled headings and Markdown headings respectively. PDF and text use standalone lines. Titles are Unicode-normalized and compared ignoring case and extra whitespace. Optional `wordRange: { min, max }` gives inclusive word counts. Each run checks for `TODO`, `TBD`, `lorem ipsum`, `[inserire]`, `[insert]` and `XXX`, with optional `extraPlaceholders` for additional literal markers. Optional `language` supports `en`, `it`, `es`, `fr`, `de` and `pt`. It identifies the language using common function words and returns `uncheckable` when the evidence falls below the documented thresholds. [Document example and heuristic](../../../docs/testing/document-e2e.md).
- `spreadsheet` accepts `.xlsx` and UTF-8 comma-delimited `.csv`, with a single sheet named `CSV` for CSV inputs. Optional `requiredSheets` lists exact sheet names. Optional `requiredColumns: [{ sheet, columns }]` compares named headers in row 1 after trimming and lowercasing. Each run scans all worksheets for spreadsheet error cells, including cached XLSX formula errors and CSV error markers. Errors name the sheet and cell. XLSX formulas require saved results. An absent cache leaves the check `uncheckable`. The workbook limit is 32 sheets and 100,000 cells. [Spreadsheet example](../../../docs/testing/spreadsheet-e2e.md).
- Optional spreadsheet `totals: [{ sheet, range, totalCell, tolerance }]` sums the populated numeric values in an A1 range such as `B2:B10`, or an entire column such as `B`. Column-letter ranges start at row 2 and omit `totalCell`. Explicit ranges must exclude the total cell. Blank cells are skipped, and a total needs at least one numeric data cell. The recorded total must match the calculated sum within the explicit, finite, non-negative absolute tolerance. XLSX formula cells contribute their saved values. CSV uses decimal or scientific notation for numbers.

## File delivery and research

Both checks accept a project-relative `cwd` and can be linked to Fusion criteria with `criteria: ["criterion-id"]` in the plan. They use verification approval, read-scope and cancellation rules. An uncheckable result leaves a linked criterion unverified.

- **Files** uses `{ kind: "files", expected: ["file:delivery/report.pdf", "dir:delivery/assets"], within: "delivery" }`. Give 1–32 relative paths of at most 256 characters. Bare entries accept either a regular file or a directory. Prefix with `file:` or `dir:` to require that type. Absolute paths, parent segments and linked paths are refused or fail. The check inspects names and types only. A missing or wrong type fails with the path. Optional `within` requires an existing directory and checks that all known new or modified files are strictly below it. A known outside path fails. Without a trusted change list, or with more than 1,024 changed paths, containment is uncheckable. The final Fusion candidate uses the change list for the whole candidate; an interactive call has no task change list.
- **Research** uses `{ kind: "research", path: "report.md", requireDates: true, network: false }`. It reads a local `.md`, `.txt`, `.docx` or `.pdf` with the document snapshot and parser limits above. Use inline numeric markers such as `[1]`, starting with a nonzero digit and containing at most six digits. In a standalone `Fonti` or `Sources` section (plain or Markdown heading), give each source on its own line beginning with the matching marker, a space or colon, and the source text. Numeric footnotes such as `[^1]` refer to single-line `[^1]: source text` definitions. The limit is 128 distinct citations and 128 sources. An unmatched citation or duplicate source fails. An uncited source warns. A source should include a four-digit year (1500–2199), either alone or in a full date. Missing years warn by default and fail with `requireDates: true`. Dates inside URLs do not count. A document with no supported sources is uncheckable unless there is already a failure.
- **Research links** are HTTP(S) URLs in source lines. Use visible URLs or Markdown links without parentheses or square brackets in the URL itself. The checker reports up to 32 distinct URLs of at most 1,024 characters. To probe them, set `network: true`. The folder must permit HTTP egress and the operator must explicitly approve the listed URLs. With network off, restricted, or approval declined, listed links stay **unverified**. HTTP 2xx verifies reachability. HTTP 404/410 or a nonexistent domain fails with the URL and citation. An inconclusive response, timeout, unsafe address, redirect or exceeded probe limit stays unverified. Each URL gets one HEAD, with a one-byte range GET fallback only for HTTP 405/501. The connection pins a public address validated by the shared HTTP guard. Redirects are never followed. Probing has a 2-second per-URL limit and a 15-second batch limit, lowered by `timeoutMs`. A research result with an unverified link is uncheckable unless another finding already fails it. See the [local fixture](../../../docs/testing/research-e2e.md).

## UI source checks

For a UI or polish milestone, add `{ kind: "ui", path: "src/index.html" }` as an optional deterministic check alongside a vision check. Add `criteria: ["contrast"]` in a Fusion plan to link the result to an approved criterion. Check multiple files with separate specs.

Use one regular markup file of up to 8 MiB, with extension `.html`, `.htm`, `.jsx`, `.tsx`, `.vue`, `.svelte` or `.astro`. Supply a path relative to the project or the optional `cwd`. For CSS, point to the markup that loads it. The scan runs in the private project copy so linked stylesheets and assets are available. Symlinked targets, directories, URLs and network options are refused.

The authorizer looks for [Impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0) under `cwd/node_modules/.bin`, the project’s `node_modules/.bin`, then the executable directories on `PATH`. Approval shows the exact executable and flags a launcher from the project as project code. The identity recheck before each launch is limited to the approved executable file. The preview flags project code because the launcher can also load modules, which are part of the code the operator is asked to trust. A separate non-grantable approval category keeps document and spreadsheet grants from authorizing it. Shell guards, saved shell restrictions and read-scope checks apply. The CLI uses `DO_NOT_TRACK=1`, the standard verification proxy restrictions and a disabled launcher download fallback.

The [Impeccable 4.10.0 CLI contract at b49177d](https://github.com/pbakaus/impeccable/blob/b49177d32788f2dc585c42831d845dacf1ebed2c/docs/CLI-CONTRACT.md) defines `detect --json --no-config` output as an array. The detector reports its version, findings and suppression marker locations. `--no-config` disables project settings and inline disable comments. An attribute `data-impeccable-ignore` or an `impeccable-ignore-start/end` marker with an otherwise passing result yields `uncheckable`, since the DOM-scoped waiver could hide a result. The marker check conservatively includes literal mentions in the target. A severe finding still fails. The version query and scan share a limit of 15 seconds or a shorter `timeoutMs`. Cancellation stops the process tree. Captured output is bounded to 1 MiB. Verify result details keep about 8 KiB of findings and suppression evidence, with a count of omitted entries.

- `pass` means exit 0 with a valid JSON array and no primary findings, including `[]` for a clean scan on the explicit file, or exit 2 with primary findings but none severe.
- `fail` means exit 2 with a primary finding whose severity is `error` or whose ID is in [the blocking rule set](impeccable-check.ts). Findings with `advisory: true` or severity `advisory` remain warnings.
- `uncheckable` covers an unsupported target, a missing or changed detector, declined or unavailable approval, a missing private copy, exit 1, invalid or contradictory JSON, a timeout or potentially active suppression markers on a would-be pass.

CSS-only targets and a missing detector return before approval or workspace copying. A declined or unavailable approval affects the UI check alone. Fusion still runs the other checks in the batch and keeps their verdicts. A required final UI check without evidence still prevents candidate promotion.

## Copy root

[verify-copy-root.ts](verify-copy-root.ts) picks the folder the throwaway copy is made from (issue #53). In an ordinary project folder that is the session's folder, as before. When the session's folder is a drive or filesystem root, the home folder or its parent (`isTooBroadScope`), `verify.run` never asks to copy it: the copy is rooted at the smallest folder holding what the run needs (an opened page's folder; the `cwd` of a command, a service or a started page; an explicit `cwd` always), widened to the nearest git root below the session's folder. The call's `cwd` and `path` are rewritten relative to that root, so the approval prompt, its `affectedResources` and the copy all name the narrowed folder. The prompt's reason and preview and the result's summary add `copied <root> only; pass cwd to widen` (and `details.copyRoot`), so the model can widen the copy with `cwd`. When the run needs the broad folder itself, it is refused up front (`reason: "workdir-too-broad"`) with the message that asks for a project folder, and nothing is sent to approval. Fusion contract checks run in their task's workspace and are unaffected.

## Turn grant for local page probes

In a session with an approved project plan, the first `verify_page_local` approval of a page file in the session's folder (`path` or a file: URL, never a loopback http(s) URL) stands for the rest of the turn, for the director's `verify.run` and the fan-out's contract page checks alike (`turnGrantFolder` in [verify-authorization.ts](verify-authorization.ts)); a different folder, a command or service run, outside content read in the turn, a saved ask/deny rule or a declined target asks again. See the [approval guide](../../approval/README.md).

## Command input and output assertions

`stdin` (command runs only, at most 64 KB UTF-8) is written to the process and closed. Without it stdin is empty. When the command reads its script from stdin, `stdin` is that script: for a shell (`sh`, `bash -s`) it is guarded, egress-checked and read-checked as the command line it is, and it removes the call's grant shape; for another interpreter (`python3`, `node`, `pwsh -`) the call asks as `commandUnreadable`, like a script piped into it. Data to a command that runs its own script is left as is. `stdout|stderr [not] matches /re/flags` tests the full captured output (up to 1 MB), under a fixed policy:

- The pattern is a `/source/flags` literal, at most 256 chars. Only the flags `i`, `m`, `s` and `u` are allowed.
- Backreferences are refused, and so is a group repeated by an unbounded quantifier whose body itself repeats or alternates (`(a+)+`, `(\w*)*`, `(a|aa)*`). Escapes and character classes are skipped, and `?` is bounded.
- The test runs in a fresh `vm` context with a 200 ms bound. A slower pattern fails the check with a reason. It never hangs the run and never passes.

## Games: the `window.__game` contract

A page run with `game: { games: 1..20, maxMsPerGame?: ≤120000 (default 30000), maxMoves? }` plays the page's game with one fixed harness, evaluated in the page. No model-written driver runs. The page must expose:

```js
window.__game = {
  start(opts) {},  // opts: { seed: number, mode: "auto" }; may return a Promise
  step() {},       // one move or turn, the computer against itself; may return a Promise
  state() { return { over: false, winner: null, moves: 0 /*, error: "..." */ }; },
};
```

Game `i` starts with `{ seed: i + 1, mode: "auto" }`. Then `step()` is called until `state().over`, `maxMsPerGame` or `maxMoves`. For each game the harness records `finished`, `winner` (`null` means a draw), `moves`, `durationMs` and `errors`. Errors include a throw from the API, a `state().error`, and every uncaught page error or console error raised during that game. Text leaves the page clipped (an error at most 300 chars, a winner at most 40) by helpers taken before any page script ran, so a game that replaces `String.prototype.slice` cannot pass a long text out. A page without the API fails the run: "the page exposes no window.__game API; the brief requires it". Games run after the script steps and before the probes. A cancel closes the browser and ends a running game at once, even inside a `step()` that never returns. `games: 0` counts as no game (a default-filled object).

Assertions:

- `games finish`
- `game errors <n>`
- `game duration < <ms>`: every game must finish, and finish under the bound.
- `game moves < <n>`: every game must finish in fewer moves.
- `game winner in [a, b, none]`
- `game winners vary`: needs N ≥ 3, and not every game the same winner.

## Screenshots

`screenshot: { fullPage?: boolean }` (or `true`) on a page run takes one JPEG at the end of the run. With `game`, it takes one at the end of each game instead, at most four per run. The caps are those of `browser.screenshot` ([page-capture.ts](../browser/page-capture.ts), [screenshot-geometry.ts](../browser/screenshot-geometry.ts)): a long side of at most 1280 px and at most 900 KB, and secret fields are masked. The caller chooses where shots are stored:

- A fusion contract check under a run stores them at `<stateDir>/fusion-runs/<runId>/shots/<taskId>-<n>.jpg` (`fusionRunShotTarget`). That folder is pruned with the run retention. A contract check may ask `judge: "vision"` to have its screenshots judged against the criteria it names; see the fusion guide's criteria facts and vision judge ([fusion](../fusion/README.md)).
- Every other run uses `<tmp>/atomic-agent-browser-shots/verify-run/`.

Files are created exclusively with mode 0600, in 0700 folders. A shot that fails is listed in `screenshotErrors` and does not fail the run.

## Result fields

`VerifyRunResult` adds `games` (a `VerifyGameSummary` with per-game `runs`, counts, medians and `winners`), `screenshots` (`{ path, bytes, width, height, clipped?, game? }[]`) and `screenshotErrors`. The summary carries a `games:` line and lists the shot paths.

## Validation

`npx vitest run src/tools/verify`. [run-page-real-browser.test.ts](run-page-real-browser.test.ts) drives a real headless Chromium: the host's browser, or a Playwright-managed one under `PLAYWRIGHT_BROWSERS_PATH`. It skips where none launches.
