# Document delivery end-to-end fixture

Status: current
Owner: repository maintainers

## Live Fusion run

The [Italian prompt](fixtures/document/prompt.txt) asks a Fusion worker to produce `report.md`, an Italian service report with the headings **Sintesi**, **Risultati** and **Prossimi passi**, 80–130 words, and no placeholders. The [Italian reference](fixtures/document/live-report.md) passes these criteria. The automated runner test also removes the required heading and inserts a placeholder to exercise the failures.

Use PowerShell 7 from the repository root with Node 25.7 or newer, installed repository dependencies, and an `atomic-agent` build configured for Fusion with a reachable director, worker and reviewer.

```powershell
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("atomic-e2e-document-" + [guid]::NewGuid())
$run = Join-Path $root "project"
New-Item -ItemType Directory -Path $run -Force | Out-Null
$stateDir = if ($env:ATOMIC_AGENT_STATE_DIR) { $env:ATOMIC_AGENT_STATE_DIR } else { Join-Path $HOME ".atomic-agent" }

Get-Content -Encoding utf8 docs/testing/fixtures/document/prompt.txt |
  atomic-agent run --cwd $run --reviewer team --auto-approve-project `
    1> (Join-Path $root "run-stdout.txt") 2> (Join-Path $root "run-stderr.txt")
$runExit = $LASTEXITCODE

node scripts/e2e-artifacts.mjs --cwd $run --fixture document --state-dir $stateDir --output (Join-Path $root "report.json")
$reportExit = $LASTEXITCODE
Get-Content (Join-Path $root "report.json")
"Fusion exit: $runExit. Report exit: $reportExit. Logs: $root"
```

The first command runs the configured models. Tool approvals follow the current policy. The report command runs locally afterward and can also report a run that stopped at a gate. It looks up the newest session in the working folder, or the session selected with `--session <id>`. Leave `--output` off to print JSON to stdout. Run each attempt in a fresh folder so its saved evidence identifies that attempt.

`artifact.checks` lists the individual file checks and their results. The verifier applies its default placeholder check to every document check. `execution` shows the recorded project gate, milestone state and keyed worker outcomes. `workerExecutions.count` counts recorded invocations only when the matching task outcome records explicitly count them. Otherwise the count is `null` and `known` reports the sum that could be verified from those records. The runner exits 0 when both artifact checks and execution evidence pass, 1 for a blocker and 2 for invalid arguments.

Run the model-free report test with `npx vitest run scripts/e2e-artifacts.test.ts`.

## Prova ermetica

Dalla radice del repository, con Node 25.7 o successivo e le dipendenze installate:

```sh
npx vitest run src/cli/run-fusion-document.test.ts
```

Il test avvia la CLI reale con il prompt italiano e cartelle temporanee separate
per il progetto e i dati. Un server su localhost fornisce risposte deterministiche
per il director, il worker e i due revisori. Le connessioni esterne sono bloccate
e le chiavi di firma sono tenute in memoria, senza accedere al portachiavi del
sistema.

La prima variante verifica le approvazioni automatiche dal brief alla consegna,
compresa la revisione di un piano con un titolo di oltre 160 caratteri (issue
#156). Controlla il verdetto del revisore del task, la chiusura della milestone,
la verifica indipendente di `report.md` e le ricevute con `project verify`.
La seconda variante verifica che il risultato di `project.plan` avvisi quando
il director assegna un revisore con `team.review: "off"` e che la consegna
arrivi comunque a termine.

## Document parser fixtures

The [brief](fixtures/document/brief.txt) asks for a weekly service report in
English. The [test](../../src/tools/verify/document-check.test.ts) executes these
files through the `verify.run` tool with the same criteria:

| Report | Expected result |
| --- | --- |
| [Reference](fixtures/document/reference.md) | Passes all document criteria. |
| [Missing section](fixtures/document/missing-section.md) | Fails because the title “Next steps” is missing. |
| [Placeholder](fixtures/document/placeholder.md) | Fails because the report still contains `[insert]`. |

Run from the repository root:

```sh
npx vitest run src/tools/verify/document-check.test.ts
```

The tool's working folder is `docs/testing/fixtures`. The reference run uses:

```json
{
  "kind": "document",
  "path": "document/reference.md",
  "requiredSections": ["Summary", "Next steps"],
  "wordRange": { "min": 55, "max": 85 },
  "language": "en"
}
```

Markdown section titles must be headings. Word titles use the standard Mammoth
heading styles. PDF and plain text use standalone lines. Titles are compared
after Unicode normalization, lowercasing and whitespace collapse. The inclusive
word range counts letter or number sequences and keeps internal apostrophes
and hyphens within a word. Markdown links contribute their labels. The default
placeholder markers are checked on every run and `extraPlaceholders` can add
literal markers.

The language heuristic checks English, Italian, Spanish, French, German and
Portuguese (`en`, `it`, `es`, `fr`, `de` and `pt`) using common function
words. It requires at least 20 words, five distinct markers for the leading
language, a lead of at least three distinct markers over the next candidate,
and at least 10% of document words matching the leader's markers. If the
evidence is insufficient the document is uncheckable. A confident mismatch
fails the check. The fixture runs locally without models or external services.
