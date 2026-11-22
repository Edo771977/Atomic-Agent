# Spreadsheet verification end-to-end fixture

Status: current
Owner: repository maintainers

## Live Fusion run

The [spreadsheet prompt](fixtures/spreadsheet/prompt.txt) asks a Fusion worker to produce `sales.xlsx` with two sales rows and a reconciled total. Run from the repository root in PowerShell 7 with Node 25.7 or newer, installed repository dependencies, and an `atomic-agent` build configured for Fusion with a reachable director, worker and reviewer.

```powershell
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("atomic-e2e-spreadsheet-" + [guid]::NewGuid())
$run = Join-Path $root "project"
New-Item -ItemType Directory -Path $run -Force | Out-Null
$stateDir = if ($env:ATOMIC_AGENT_STATE_DIR) { $env:ATOMIC_AGENT_STATE_DIR } else { Join-Path $HOME ".atomic-agent" }

Get-Content -Encoding utf8 docs/testing/fixtures/spreadsheet/prompt.txt |
  atomic-agent run --cwd $run --reviewer team --auto-approve-project `
    1> (Join-Path $root "run-stdout.txt") 2> (Join-Path $root "run-stderr.txt")
$runExit = $LASTEXITCODE

node scripts/e2e-artifacts.mjs --cwd $run --fixture spreadsheet --state-dir $stateDir --output (Join-Path $root "report.json")
$reportExit = $LASTEXITCODE
Get-Content (Join-Path $root "report.json")
"Fusion exit: $runExit. Report exit: $reportExit. Logs: $root"
```

The run uses the configured models and follows the current tool approval policy. The report reads `sales.xlsx` and the saved Fusion evidence locally. Use `--session <id>` to select a particular session in the folder, or omit it for the newest one. The report records sheet, column, error-cell and reconciliation checks under `artifact.checks`. The error-cell scan applies to every workbook check. See the [document workflow](document-e2e.md#live-fusion-run) for report fields and exit codes.

The model-free runner test uses the workbooks below. Run it with `npx vitest run scripts/e2e-artifacts.test.ts`.

## Workbook parser fixtures

Verify a sales workbook with a `Sales` sheet and `Item` and `Amount` headers in row 1. Add the amounts in B2 and B3 and compare the result with B4 within an absolute tolerance of 0.01. Report spreadsheet errors with their cell address.

## Files

| Workbook | Expected `verify.run` result |
| --- | --- |
| [sales.xlsx](fixtures/spreadsheet/sales.xlsx) | Pass. Two amounts of 12.50 add up to 25.00, matching the total formula's cached value. |
| [formula-error.xlsx](fixtures/spreadsheet/formula-error.xlsx) | Fail. `Sales!B3` contains a cached `#REF!` error. |
| [wrong-total.xlsx](fixtures/spreadsheet/wrong-total.xlsx) | Fail. `Sales!B4` contains a cached total of 26.00, while the two data cells add up to 25.00. |

Run all three cases from the repository root. The [test](../../src/tools/verify/spreadsheet-e2e.test.ts) invokes the registered tool implementation on each workbook and checks the status and failure detail. The fixtures use saved formula results, so the run requires no spreadsheet application or network access. Opening and resaving the wrong-total fixture in an application that recalculates formulas can replace its intentionally incorrect cached total.

```sh
npx vitest run src/tools/verify/spreadsheet-e2e.test.ts
```

This is the `verify.run` call used for the reference workbook, with the fixture folder as the working directory.

```json
{
  "kind": "spreadsheet",
  "path": "sales.xlsx",
  "requiredSheets": ["Sales"],
  "requiredColumns": [{ "sheet": "Sales", "columns": ["Item", "Amount"] }],
  "totals": [{ "sheet": "Sales", "range": "B2:B3", "totalCell": "B4", "tolerance": 0.01 }]
}
```
