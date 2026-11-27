# B7a3 provider refusal tags

Status: current
Owner: docs/reviews/

Imported 78586bb3bb480c9f6c51ceafabbe640c593e98e2 and cac95a69a2c8dba4b57a942397020ac148a1cd06 as separate cherry-pick -x commits from fork main 904476e2e099903833223beb4a0ace08b8d7a220. Conflict resolution retains the registered-serve-key scrubber test and the fork's parsed param field for invalid-sampling failover classification; Google's status/array support is additive. The README keeps the fork's reporting opt-in and incognito contract.

Tests were written before import. After both upstream commits, four privacy assertions fail: identifier-shaped user data is accepted as an upstream error code, and an unknown identifier takes precedence over a recognized Google status. Paths, emails and non-identifier strings are controls. The adaptation replaces the code regex with a literal closed vocabulary. Unknown codes are omitted, and a recognized status can still be used. New reasons are a literal union; parameter paths keep only upstream's known roots and structural links, with indices removed and user maps cut to *. Sentinel tests inspect both the extracted detail and envelope tags. Existing upstream tests cover chosen tool/schema names and filenames.

No new analytics sink is added. Only scrubbed Sentry event fields/tags change; fingerprints stay unchanged. Delivery tests exercise the real Sentry client's offline drop and telemetry factories' disabled flags, with existing runtime-observability tests checking the late incognito gate. No provider sentence, credential, file path, email or user identifier is admitted to the new fields. Existing upstreamErrorType has its prior bounded-shape contract and is outside this change's new fields.

## Verification results

The [verification record](b7a3-verification.json) preserves upstream provenance, red/green controls and initial attempts plus final retries. All final setup/static/documentation checks pass. The [name-by-name comparison](b7a3-comparison.json) uses the same main baseline and preserves every initial failure.

Requested focused suite: **13038 passed, 25 failed, 38 skipped**. 24 initial failures match main's complete run by file and full test name; 1 additional names are accounted for by the recorded controlled reruns. No additional failure remains unresolved. Every new test passes.

Main's complete run: **30572 passed, 157 failed, 658 skipped**. A failed baseline test that passes here is recorded without attributing a fix to this feature. These reports do not claim an entirely green suite.

The one additional cleanup name also fails in the paired main control and passes in the later selected main control, documenting its environment sensitivity. No production cleanup code is changed.
