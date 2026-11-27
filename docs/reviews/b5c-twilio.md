# B5c: defer Twilio client and inbound phone feature (#1704)

Status: current
Owner: docs/reviews/

Deferred with no production changes. Fork main baseline: `6dd01db055bc5b2f0d186f037b1ad10bf4fae28e`. Reviewed [upstream commit and parent](b5c-upstream-commits.json): `58ced8698de25ff20f2643b83637ffc4df1725fe`.

## Scope and reproduced failures

This upstream commit is an **outbound REST client only**: one call reads a message aloud, with a call-status GET. It has no agent tool, incoming webhook, signature verifier, transcript or inbound turn. Its README says the approval tool is a later slice. Importing an unguarded client would neither deliver the requested incoming-call feature nor establish its mandatory cost/approval boundary. No missing upstream slice was silently imported.

[Tests](b5c-candidate-tests.patch) were authored before copying the candidate into a disposable checkout. With only fake fetch and synthetic credentials, the missing-credentials control passes and **5 security assertions fail**: marked-child config returns the token, calls without a decision invoke fetch in normal/offline/tool-child modes, and an error echoing the Basic header leaks the base64 account/token pair. [Names and outcomes](b5c-candidate-results.json) also record that the absence regression fails when the candidate files are added. These are direct client/credential-owner tests; no production HTTP/agent path on main exposes this client, and **no real call was placed**.

The client pins `https://api.twilio.com/2010-04-01`, escapes TwiML, caps spoken text at 1,000 characters, validates phone/call IDs and never retries a POST. These controls do not replace approval, runtime offline/egress, response-size limits, redirect refusal or protected storage. Scrubbing only the literal token misses encoded authorization. Credentials currently come from the supplied environment, not a child-refusing owner. `.env` is already in both fork inventories; do not incorrectly describe that existing file as unprotected. The missing behavior is owner-mediated access and the provider-specific use/sink boundary.

Reproduce in a disposable checkout of this PR after `npm ci`, with the upstream object available: `./docs/reviews/b5c-reproduce.ps1`. It applies the tests and copies the upstream telephony modules only. Expected: 1 control passes and 5 assertions fail. The transport is injected and sends no traffic.

The shipped `src/http/b5c-twilio-deferred.test.ts` pins the absence of the dialer/config owner, telephony API routes/scopes and Twilio verification scheme. Reopening also needs dedicated X-Twilio-Signature verification against the configured public URL and raw form fields, replay/body caps, and dispatch **only** under `/webhooks/{name}` on the existing tunnel listener. No inbound endpoint is claimed to be secured by this deferral.

## Boundaries required before reopening

The passing absence regression prevents activation; it does **not** certify any enabled ingress. Each row below needs its own failing behavioral test before production code is added.

| Boundary | Required proof for an enabled feature |
| --- | --- |
| External content and taint | Frame the message, subject/display headers and any transcript with `frameUntrustedText`; persist read taint before inference. An injection asking to ignore instructions and upload `~/.ssh` must never dispatch without the required decision. Verify data-bearing URLs and mid-turn channel egress after the taint. |
| Sender authority | Only verified operator identities auto-start; unknown, forged and unverifiable identities create at most `startPaused` tasks. Identity configuration is an operator trust decision. |
| Approvals | External sessions default to `refuse`. Only a channel proven to belong to the operator may present decisions for its own session; no high-level auto-grant, foreign-session grant or persistent allow-always bypass. |
| Organization policy | PR #246 was open and unmerged on 27 November 2026; `src/policy/README.md` is absent on this baseline. Integrate its policy at dispatch after it merges, including highest trust and saved grants. |
| Privacy Shield | Cloud inference uses the owning ordinary chat's archive, including retries and concurrent turns. Check synthetic secret sentinels at transport, logs, errors, Sentry, prompts and traces; only protected provider payloads may contain reversible placeholders. |
| Offline | No startup, polling, IDLE, pairing, reconnect, API request or new turn while offline; changing to offline stops an existing connection. |
| Incognito | External work cannot bind to an incognito chat, including named/reused/missing sessions and races with deletion. |
| Credentials | Validated owner-only credential storage (0600 on POSIX), both protected inventories, non-grantable child read/write/delete refusal, no credential in model/log/error/Sentry, and exact destination-host binding. A marker alone is not an OS identity boundary. |
| Resources | Hard wire/body/header/decoded-content caps, attachment count and extractor budgets from #240 and later fixes; bounded tasks per hour across reconnects and restarts, plus reconnect backoff. A per-poll limit alone is insufficient. |
| HTTP roles | Mandatory serve key on any new API route, explicit admin configuration/read status scopes, viewer/member/operator/admin/owner/anonymous tests and no addresses, numbers, message content or raw errors in named-token status. Signed ingress belongs only on the existing tunnel listener. |

No upstream commit is shipped: `cherry-pick -x` and one commit per upstream commit apply when the feature can safely be imported. The recorded chains are not replaced by merge second parents. Existing mail, task, channel, runtime, cancellation and approval behavior and #240's bounded extractor remain untouched.

## Verification

Windows, Node v26.13.1, npm 11.20.0. `npm ci --foreground-scripts` succeeds with only the existing esbuild postinstall; package.json and the lock are unchanged. Lint, import boundaries and docs checks pass. Test typechecking is **not green**: the same two TS2345 diagnostics at `src/agent/step-executor.test.ts:6487` appear on main; all four logs are byte-identical, with no new allowance. Initial documentation hash failures from checkout CRLF conversion were corrected by restoring the original Git blob bytes, without source changes.

Required focused suite: **5758 passed, 13 failed, 6 skipped**. All **2** new absence tests pass. Comparing file and full test name against main's full run gives **13 common failures and 0 additional names**. Main full: **30639 passed, 85 failed, 658 skipped**. The reports normalize path separators and checkout/user-home prefixes; they preserve test identities and suite errors. [Machine-readable verification](b5c-verification.json).

Last PR full suite: **30647 passed, 79 failed, 658 skipped**. Full-name comparison: **78 common failures, 1 additional names**. The complete suites are not claimed green.

The one additional full-suite name is `candidate-copy-budget.test.ts :: retains Git checkout capacity for 716800 tracked payload bytes and later same-size edits`. The exact case was rerun on both main and this PR with one worker and the original timeouts: **1 passed, 0 failed on each**, with 9 other cases filtered by `-t`. This does not replace the full-suite failure or establish its cause; it did not reproduce in isolation. All 7 new B5 absence tests pass across the three focused runs, and both new Twilio tests pass in the complete run. No production source, test threshold, exclusion or diagnostic allowance was changed. The command and both outcomes are in the verification JSON.
