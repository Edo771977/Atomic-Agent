# C1d: profile loading

Status: current
Owner: src/agent-profiles/

Imported with cherry-pick -x: f60f1141c088e352eaf044f22b0c69c9fa48cfa2 and 77fceafae5c12fd8d0d51948e0678afe6f352165.

The fresh-load test fails before import: settings source absent. The fork tool-admission test fails on the upstream candidate: unknown.tool is accepted beside os.fs.read. The adaptation validates aliases/patterns against the actual registered catalog and worker ceiling. A forbidden or unknown selection rejects the person-authored candidate with a diagnostic. The [PR review correction](c1-review-corrections.md) removes the initial rejected-name reservation: a valid lower-priority copy can load, and built-ins omit unavailable optional tools. Validation never grants execution permission. Existing runtime dispatch, project provider constraints, approval levels and file protections remain authoritative.

The settings reload and admission tests, actual fresh config reads, stable-prefix equality, parser, task-profile and runtime catalog selection pass (69 tests before adding the prefix assertion). Project-file trust code is unchanged. Windows trust/symlink failures from the larger selection are compared with main; they are not reported as passing.

README conflict resolution retains the fork's split-profile inheritance, profile shadowing warnings, checkpoint accounting and verification/candidate contracts. config.json remains a protected person-owned file.

The prefix assertion also uses the complete prompt builder on the same open session in both local and cloud modes. Two actual config edits change the loaded instructions and subsequent task brief; the complete stablePrefix stays byte-identical and excludes those instructions. All three settings-import tests pass with this stronger session-level check.

The full suite catches a later generated-reference drift: C1d changes the schema JSDoc from not-yet-loaded profiles to the implemented loading order, after C1c's generation. Regenerating both reference outputs updates that description. The generator's exact-byte test then passes; no runtime function changes.
