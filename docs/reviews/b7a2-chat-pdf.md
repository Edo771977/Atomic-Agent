# B7a2 chat PDF export

Status: current
Owner: docs/reviews/

Imported upstream 061d019cc7f05c3f648a938d3ede5e112bbc74ce with cherry-pick -x from main 904476e2e099903833223beb4a0ace08b8d7a220. Conflicts retain the fork's known-secret filename masking, CLI force flag and other slash commands. The upstream documentation conflicts retain the current module guides and this adaptation updates them separately.

Tests were written before the import. On the unadapted candidate, seven assertions fail and one inert-PDF control passes: incognito writes without consent, config credentials leak through filenames, explicit paths overwrite, and no confirmation syntax exists. The adaptation requires --confirm-incognito in the TUI, passes runtimeKnownSecrets(getConfig()) to content and filename rendering, and uses wx unless --force is explicit. CLI and HTTP continue refusing incognito; named callers receive the listener's existing indistinguishable 404 for hidden/incognito IDs. The confirmation is per invocation and is never saved. Flags precede the format/path.

The PDF renderer emits plain text using Node buffers and compression. It performs no resource loading, image fetching, browser rendering or active-content execution. Tests forbid fetch and inspect the PDF for active actions. No package or lockfile change is introduced; therefore no new installation script exists. Compressed PDF streams and all DOCX entries are inspected for a configured credential sentinel. Standard PDF fonts have limited character coverage; upstream transliteration warnings are preserved.

Existing Windows path assertions were made platform-aware; all file tests isolate config/state. CLI exclusive creation remains atomic and PDF follows the existing binary-file path.

## Verification results

The [verification record](b7a2-verification.json) preserves upstream provenance, red/green controls and initial attempts plus final retries. All final setup/static/documentation checks pass. The [name-by-name comparison](b7a2-comparison.json) uses the same main baseline and preserves every initial failure.

Requested focused suite: **13004 passed, 26 failed, 38 skipped**. 24 initial failures match main's complete run by file and full test name; 2 additional names are accounted for by the recorded controlled reruns. No additional failure remains unresolved. Every new test passes.

Main's complete run: **30572 passed, 157 failed, 658 skipped**. A failed baseline test that passes here is recorded without attributing a fix to this feature. These reports do not claim an entirely green suite.

Both initially additional cleanup cases pass in the selected rerun on this branch and main (2 passed, 6 unselected). No source change to session-worktree cleanup is made.
