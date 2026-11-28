# W5.1b: disarmed configuration import

Status: current
Owner: docs/reviews/

Base: fork main c9aaeedadad412242b00ed230da369ffb7223f81. This branch is independent of W5.1a. Origin is Edo771977/Atomic-Agent; upstream is AtomicBot-ai/atomic-agent.

Imported separately with cherry-pick -x: 27feba858af57e195e89d8d99c80829d4c4bbc24, 120028a28363064dca0abbbfdb4a99dc28758302 and 38b53193d05e8299403633ebba791d520ee3f9f7. Upstream setup-share is absent on main: the last cherry-pick retains only the self-contained credential filter and its tests. Bundle import/export, profile/persona plumbing and the upstream setup-import tests remain absent. The LLM README conflict retains fork privacy/provider behavior.

## Review and adaptations

Imported apiKeyCommand is always discarded, regardless of migrateSecrets. Only well-known key-variable names at the original exact known destination may survive. Names are checked before removing a destination so removal cannot accidentally approve a previously foreign native name. The filter covers native Anthropic as well as OpenRouter, AI/ML API and Gemini; compatible providers also lose unknown destinations. URL userinfo is rejected for credential destinations. Per-account hosts and loopback are not implicitly trusted as imported credential destinations.

A provider whose destination is dropped is withheld as a skipped entry: it is not registered, and deleting its address cannot activate built-in default credentials. The report contains field names, not the original address or command. This is deliberately stronger than upstream, which falls back to the kind's built-in endpoint. Re-entry after reviewing the source is a separate operator configuration action, not an import flag or a stored executable candidate. The import provides no confirm/approve/unlock interface; migrateSecrets never restores discarded fields. Supported operator CLI configuration writes refuse marked children. This does not claim that inherited metadata authenticates arbitrary same-account code or repair the existing owner-credential HTTP boundary from #235.

The resolver and origin restrictions from #222/#241 are unchanged. In particular, reserved native keys remain limited to their official origin or literal approved loopback; dotted localhost, wildcard lookalikes, LAN addresses and downgraded official HTTP URLs do not acquire new permission. Existing provider-credential-review tests remain conservation evidence.

Helper environments are built per run, strip provider/bot keys and ATOMIC_AGENT settings, explicit configured credential names (including ordinary names) and aliases of known credential values, and receive the tool-child marker and B1 policy context. Only named password-manager and cloud CLI sign-in variables may bypass secret-name filtering, rather than arbitrary AWS_/AZURE_/CLOUDSDK_ credentials. Helper access to OS-readable files is not confined by this filter. No raw command, provider label, unknown error code, stderr or token is emitted by helper failures. Configuration parse/write failures use fixed diagnostics, and unsafe provider identifiers do not enter reports.

No secret-value or OAuth APIs from #260/#261 are added. This is configuration import, not facts: C3b and the related consent/archive/job requirements remain deferred. No chat-export/shared masker or agent-profiles files changed.

## Evidence

The initial upstream tests produced six failing assertions before production imports, plus the expected missing filter module. A post-upstream review produced sentinel failures for foreign destinations, helper passthrough and raw diagnostics. The final adapted tests were rerun against the unadapted imported production code: 12 failures, before reapplying the production adaptation. Two additional RED tests reproduced the ordinary-name credential leak and the missing factory wiring; a further RED reproduced custom credential-header omission. The focused final suite includes the actual factory, helper execution and existing #241 credential tests.

The [verification record](w51b-verification.json) records exact RED names, final focused checks, all mandatory checks, absence tests and the comparison with fixed main. Conservation checks and missing-module errors are not counted as new behavioral RED assertions.

Final checks: npm ci, lint, imports:check, typecheck:tests and docs:check pass. Focused tests: 88 passed; deferred API absence: 11 passed. Required suite: 13,509 passed, 16 failed, 187 skipped. Fixed main: 13,490 passed, 16 failed, 187 skipped. Fifteen failures coincide by file/name. The additional restore-quota case failed in afterEach temporary-directory cleanup with EPERM; it passes in both isolated file rechecks (21 passed, two identical existing failures on each). The suite is not wholly green. The intermediate full run and all RED cycles remain recorded rather than being replaced by the focused reruns.
