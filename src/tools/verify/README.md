# Verification tools

Status: current
Owner: src/tools/verify/

`verify.syntax` syntax-checks files; `verify.run` runs what was built (a command, a service or a page) against a throwaway copy of the working directory and evaluates `checks` on the result. Fusion contract checks are `verify.run` specs run through [`runChecks`](run-verify.ts). Read [tool instructions](../AGENTS.md) and the adjacent tests before changing behavior.

## Entry points

- [verify-run-args.ts](verify-run-args.ts): argument parsing and bounds; errors name the field.
- [run-verify.ts](run-verify.ts): `runVerify` / `runChecks` and the `VerifyRunResult` shape.
- [verify-authorization.ts](verify-authorization.ts): the approval plan, shared by the tool and contract checks; only declared fields pass.
- [verify-checks.ts](verify-checks.ts): the assertion language. An unknown check fails; it never passes.
- [run-page-kind.ts](run-page-kind.ts), [page-game-harness.ts](page-game-harness.ts), [page-screenshots.ts](page-screenshots.ts): the headless page run, its game harness and its screenshots.
- [safe-regex.ts](safe-regex.ts): the regex policy of `matches` checks.

## Copy root

[verify-copy-root.ts](verify-copy-root.ts) picks the folder the throwaway copy is made from (issue #53). In an ordinary project folder that is the session's folder, as before. When the session's folder is a drive or filesystem root, the home folder or its parent (`isTooBroadScope`), `verify.run` never asks to copy it: the copy is rooted at the smallest folder holding what the run needs (an opened page's folder; the `cwd` of a command, a service or a started page; an explicit `cwd` always), widened to the nearest git root below the session's folder. The call's `cwd` and `path` are rewritten relative to that root, so the approval prompt, its `affectedResources` and the copy all name the narrowed folder. When the run needs the broad folder itself, it is refused up front (`reason: "workdir-too-broad"`) with the message that asks for a project folder, and nothing is sent to approval. Fusion contract checks run in their task's workspace and are unaffected.

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
