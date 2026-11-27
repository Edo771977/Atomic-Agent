# C2b: suggestions from a separate small model

Status: current
Owner: docs/reviews/

Deferred under issue #233 without production changes. Base: fork main `50b6d9601`; origin is `https://github.com/Edo771977/Atomic-Agent.git`, upstream is `https://github.com/AtomicBot-ai/atomic-agent.git`. This is the requested C2b slice of #1606, not the older issue table's file-index series.

## Candidate and provenance

The isolated candidate imports each upstream commit separately using `git cherry-pick -x`:

- `5635a685a69e8a9396f286a65e15eb462bf6ee60`: endpoint and runtime integration.
- `e3bece095181a0ba104b27d214f1bff1df064657`: thinking-off request and one retry without thinking on HTTP 400.
- `207685fa984328d304460a347433c7ba4ad781d3`: environment-variable documentation.

The runtime conflict retains the fork's providerId forwarding and transport selection. The env-settings conflict retains the fork inventory and inserts only these three endpoint variables. The documentation commit is evaluated even though the older triage counted two commits. None of these cherry-picks enters this deferral branch.

## Reproduction and observed results

Run `npm ci` in the review checkout and the disposable candidate checkout. Apply that chain to a separate checkout from the stated base with the conflict choices above. Set `C2_CANDIDATE_ROOT` to it and run `node --import tsx --test docs/reviews/c2b-candidate.mjs` from this branch. The script loads the actual candidate runtime and endpoint modules, the fork provider-policy frame, offline switch and Privacy Shield registry. All configuration and data are synthetic and temporary. Fetch is intercepted at the transport seam; no remote host is contacted. These tests prove calls are attempted without preflight checks, not that the process-wide offline dispatcher allows external traffic.

The [candidate output](c2b-candidate.log) contains **12 assertions: 5 pass, 7 fail**:

- The runtime attempts a loopback endpoint in offline mode. This violates this slice's explicit no-suggestion-request requirement even though the general offline dispatcher deliberately permits local models.
- A local-only provider policy and a separate host-limited policy each allow the raw endpoint call to reach fetch. It is outside the guarded provider registry, so allowedProviders and allowedProviderHosts do not protect it.
- A known synthetic credential in conversation text is transmitted unchanged with Privacy Shield enabled, both before HTTP 400 and on the retry without thinking. An authorization header intentionally containing the endpoint key is excluded from this text-masking assertion.
- A malformed environment key becomes a bearer key through trimming alone, and a URL containing userinfo is accepted. The separate endpoint does not use the validated provider/credential path.
- A synthetic error reflecting the endpoint key on the second attempt reaches an actual StructuredLogger sink unchanged. The first response is HTTP 400, so this tests the retry path rather than only the first request. No real credential is included in the evidence.

The original upstream endpoint and runtime-suggester suites pass: 16 tests in two files. Passing audit controls verify one thinking-off attempt then one without that option, intended authorization on the retry, runtime refusal of remote incognito suggestions, a 120-character stored result outside the transcript/cloud journal, data-only suggestion events, settled errors and the runtime's approximately 15-second abort deadline for a signal-aware transport. They do not establish protection against a transport that ignores abort or an unbounded HTTP response body. The runtime currently skips local incognito suggestions too; no claim of enabled local-incognito support is made.

The [absence regression](../../src/runtime/composition/next-step-endpoint-deferred.test.ts) is red on the candidate (all three tests fail; [report](c2b-absence-red.json)). On the deferral branch it proves the endpoint module and environment-setting inventory are absent and that setting URL/model/key has no effect for local or remote addresses, offline on/off and a local-only policy. The established suggestion path still calls the configured model with the original providerId and auxiliary session partition. This is candidate-red/deferral-green evidence, not an enabled implementation or a main-red feature test.

## Before reopening

Observe a failing test for each invariant before adding its adaptation:

- Treat the endpoint as a configured provider identity and apply existing provider, egress, host and stored/read-taint policy before every request, including retry and redirect. Offline must start no suggestion request, including loopback; cloud-forbidden projects must start no nonlocal request.
- Use fresh per-call Privacy Shield archives with the cloud provider's filtering on both attempts. Cover credentials and private text, concurrent chats, failed calls and archive disposal. Incognito may use only local endpoints, subject to all other constraints, and must not be resurrected by a late save after close.
- Admit credentials only through validated configuration/credential resolution. Reject userinfo, malformed keys and unsafe redirects; never send a provider's key to an arbitrary new endpoint. Logs, public errors and reports must exclude credentials from URLs, headers, bodies and transport failures, including the HTTP-400 retry.
- Keep a bounded result as display data outside the principal prompt and all tool-dispatch paths. Bound response bytes as well as the final string. Add a deliberate untrusted-data frame if any later feature includes it in a prompt.
- Keep an explicit deadline and cancellation ownership; failures, HTTP 400/5xx, malformed output and timeout must settle without delaying/failing the already-finished turn. Exercise teardown and close races with the actual runtime store.
- Only after these guarantees pass, document the three variables in env-settings.ts, regenerate the settings reference and update src/session/README.md. Deferred settings must not be advertised as working configuration in the active inventory.

No production files, agent/step, policy, Fusion or subagent paths change in this PR. Only the respective triage rows, fork guide, affected module README files, the absence regression and review evidence change.

## Verification

[Verification record](c2b-verification.json): npm ci, lint, imports:check, final typecheck:tests and docs:check pass. The complete requested focused selection records **8,028 passed, 13 failed, 6 skipped**; all [three new tests pass](c2b-new-tests.json). Its [focused comparison](c2b-focused-comparison.json) reproduces 12 failed names on main, and the remaining login-absence subprocess case passes on both checkouts in paired controls.

Both complete runs use `npm test -- --maxWorkers=8`, with no added exclusions. Clean main: **30,831 passed, 165 failed, 660 skipped**. C2b: **30,794 passed, 205 failed, 660 skipped**. The [full name comparison](c2b-full-comparison.json) preserves 151 common failures, 54 initially additional names and 14 main failures that pass here. Checkout roots in parameterized names are normalized, not omitted.

All 54 additional names were rerun on main and C2b with two workers: 53/54 pass on main, 52/54 on C2b. The two remaining C2b cases hit the existing 15-second limit; one also fails in that main control. Final sequential runs of those two names pass on both checkouts without raising the limit. No additional failure remains unresolved. Fusion and script source/tests are byte-identical to main. Targeted-control skips are the other tests in those files, not exclusions from either complete run. Initial failures remain in the report; no unrelated fix or entirely green full suite is claimed.

The companion C2a deferral is [PR #282](https://github.com/Edo771977/Atomic-Agent/pull/282).
