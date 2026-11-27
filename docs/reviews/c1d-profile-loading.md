# C1d: profile loading

Status: current
Owner: src/agent-profiles/

Imported with cherry-pick -x: f60f1141c088e352eaf044f22b0c69c9fa48cfa2 and 77fceafae5c12fd8d0d51948e0678afe6f352165.

The fresh-load test fails before import: settings source absent. The fork tool-admission test fails on the upstream candidate: unknown.tool is accepted beside os.fs.read. The adaptation validates aliases/patterns against the actual registered catalog and worker ceiling. A forbidden or unknown selection rejects the whole profile with a diagnostic; reserving the rejected name prevents silent fallback. Validation never grants execution permission. Existing runtime dispatch, project provider constraints, approval levels and file protections remain authoritative.

The settings reload and admission tests, actual fresh config reads, stable-prefix equality, parser, task-profile and runtime catalog selection pass (69 tests before adding the prefix assertion). Project-file trust code is unchanged. Windows trust/symlink failures from the larger selection are compared with main; they are not reported as passing.

README conflict resolution retains the fork's split-profile inheritance, profile shadowing warnings, checkpoint accounting and verification/candidate contracts. config.json remains a protected person-owned file.
