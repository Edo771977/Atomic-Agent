# CSV sales end-to-end fixture

Status: current
Owner: repository maintainers

A repeatable live check of a three-role fusion run (issue #95, item 4): a cloud director, a local worker and a subscription reviewer build a small program and its tests as separate tasks, and one JSON report records how it went. It needs real models, so it is run by hand; only its own parts are unit-tested.

## Files

- [prompt.txt](fixtures/csv-sales/prompt.txt): the request, one line, because `atomic-agent run` takes each piped line as a separate turn. It defines the program's interface: `sales.cjs` in the run folder, run as `node sales.cjs <input.csv>`. The first line must be exactly `sku,qty,price_cents`, else "Invalid header" on stderr and exit 1. A malformed or negative number gives "Invalid row" and exit 1. On success it prints one JSON object of sku to integer revenue in cents. The agent's own tests are `sales.test.cjs`.
- [acceptance.test.cjs](fixtures/csv-sales/acceptance.test.cjs): our independent acceptance test, never shown to the agent. It covers repeated skus, zero values, the prototype-key skus `toString` and `__proto__`, a wrong first line with no valid header before it, and negative, non-integer and non-numeric input. It runs any conforming program: `CSV_SALES_PROGRAM=<path> node --test acceptance.test.cjs`.
- [Runner](../../scripts/e2e-csv-sales.mjs): runs both test suites and reads the persisted state, read-only, into one report. It uses Node built-ins only (Node 25.7 for `node:sqlite`) and no shell, so it is the same command on Windows and POSIX.
- [Unit test](../../scripts/e2e-csv-sales.test.ts), part of `npm test`. The acceptance test must pass the [reference implementation](../../scripts/test-fixtures/csv-sales/reference-sales.cjs) and fail the `{}`-accumulator (`toString`) defect, a missing header check and `parseInt`-style parsing. The runner must read a [recorded sample run](../../scripts/test-fixtures/csv-sales/sample-run). That sample is synthetic, in the formats the CLI and the outcome log write.

## Running it

Use an empty folder for the run, and keep the logs and the report outside it. The flags below are `atomic-agent run`'s (`--allow-command` from issue #95's non-interactive verification, in builds that have it); `--worker` is optional (the issue #95 run used the local `qwen-3.6-35b-a3b`). PowerShell on Windows:

```powershell
$run = "C:\e2e\csv-sales"
New-Item -ItemType Directory -Force $run | Out-Null
Get-Content docs\testing\fixtures\csv-sales\prompt.txt | atomic-agent run --cwd $run --max-steps 12 `
  --director anthropic:claude-opus-5-5 --reviewer codex-cli:default --auto-approve-project `
  --allow-command "node --test sales.test.cjs" `
  1> C:\e2e\run-stdout.txt 2> C:\e2e\run-stderr.txt
$code = $LASTEXITCODE
node scripts\e2e-csv-sales.mjs --cwd $run --log C:\e2e\run-stdout.txt --log C:\e2e\run-stderr.txt --run-exit $code --output C:\e2e\report.json
```

POSIX shells, the same command:

```sh
atomic-agent run --cwd "$RUN" --max-steps 12 --director anthropic:claude-opus-5-5 --reviewer codex-cli:default --auto-approve-project \
  --allow-command "node --test sales.test.cjs" \
  < docs/testing/fixtures/csv-sales/prompt.txt > run-stdout.txt 2> run-stderr.txt
code=$?
node scripts/e2e-csv-sales.mjs --cwd "$RUN" --log run-stdout.txt --log run-stderr.txt --run-exit "$code" --output report.json
```

`--allow-command` pre-approves exactly that command, run directly with no shell and only in `--cwd`, so the piped run can run the agent's tests and the milestone gate gets their result; any other command still asks. The acceptance test is not pre-approved: the runner runs it after the run, and the agent never sees it.

The runner reads the session store and the outcome log from `--state-dir`, which defaults to `ATOMIC_AGENT_STATE_DIR`, else `~/.atomic-agent`. It finds the session from `--session`, else from the `session: <id>` line printed at a project gate, else as the newest session in `--cwd`. It exits 0 when both suites pass and 1 otherwise.

## The report

- `tests`: the exit code, TAP counts and failing test names of the acceptance test and the agent's `sales.test.cjs`, and whether both passed.
- `project`: the persisted gate, the plan rows (task, worker, reviewer) and each milestone's state, runs and criteria facts.
- `tasks`: each plan row (task, milestone, worker, reviewer) with its verdicts from `fusion/outcomes.ndjson`: status, attempt and reviewer decision (null when no review ran). The log holds no plain id, only `taskKey` and `milestoneKey` (the first 16 hex characters of the sha256 of the UTF-8 id); the runner computes the same keys from the plan rows and joins on them (`join: "key"`). A row from an older build without keys goes, in order, to a task no keyed verdict reached, labelled `join: "order (unjoined)"`. `unmatchedVerdicts` lists the verdicts no task took; `verdicts` keeps them all, oldest first, and `unreviewedTasks` counts those without a review.
- `receipts`: each turn receipt's strong-side and worker spend and their sums. `run.receiptLines` keeps the `fusion receipt ·` lines found in the logs.
- `run`: the run's exit code (3: stopped at a project gate) and the session it printed.

Limits: this fixture does not judge code quality beyond the acceptance cases. A run that leaves no session or outcome records still gets a report, with the errors named.
