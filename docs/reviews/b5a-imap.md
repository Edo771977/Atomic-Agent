# B5a: defer IMAP task ingress (#1702, #1719)

Status: current
Owner: docs/reviews/

Deferred with no production changes. Fork main baseline: `6dd01db055bc5b2f0d186f037b1ad10bf4fae28e`. [Exact upstream commits and parents](b5a-upstream-commits.json): #1702 `ca1f9d2e8`, `7b38db07f`, then #1719 `a4c354b41`, `8de2d3636`, `0a44b153d`, `4f4e4f124`. The shared `ca1f9d2e8` is counted once. The branch rows, not the one-commit second parents, establish this order.

## Reproduced candidate failures

[Tests](b5a-candidate-tests.patch) were written before copying candidate modules into a disposable checkout. The initial run failed to load the three missing candidate modules. After extraction and a correction to match the fake server's password, **4 controls pass and 6 security assertions fail**. [Names and outcomes](b5a-candidate-results.json) also include an absence regression that fails when candidate files are present. No real mailbox, password, provider request or agent action is used.

These tests stop at the task-creation callback: auto-start below means the candidate emits `startPaused: false`. They collect that request rather than running TaskRunner, a model or a tool. The #1702 prerequisite would persist such a request as pending and permit eager drain; its sibling `7b38db07f` only fixes the test fixture's type. The IMAP producer and its exact prerequisite chain are deferred together.

- With two `From` header lines, `splitPart` retains the first and silently drops the second. The owner address wins and the task auto-starts. A different `Sender` or `Reply-To` is also ignored and auto-starts.
- `autoStartSenders: ["@example.com"]` accepts any authenticated domain user as the operator. DMARC/SPF/DKIM authenticate a domain, not the local-part/person. The candidate has no independent operator mailbox proof.
- `trustFromHeader: true` allows the operator's bare From to auto-start with no Authentication-Results or configured authserv-id. An authserv-id string comparison alone cannot prove the header came from the receiving server: deployment must also ensure the receiving server removes forged matching headers and produces its own trusted result. This provenance property was **not** established by the fake server test.
- `resolveImapSecret` returns a synthetic environment password even when that environment contains `ATOMIC_AGENT_TOOL_CHILD=1`. It has no credential-owner refusal. Inline passwords and arbitrary `passwordEnv` also need validated storage, host binding and scrubbing review; absence tests do not certify them.

The positive controls prove the latest parser keeps addresses hidden in quoted/encoded display names from becoming owner identities, does not normalize a plus address into the owner, and frames the malicious body and decoded subject through the existing mail builder. `4f4e4f124` masks encoded words **for From identity parsing**, not every displayed field. The shared builder decodes Subject and flattens control characters in displayed From/Subject/Received inside the external fence; forwarded headers remain external body content. Do not confuse that control with read taint or a full approval integration test.

Static review: TLS uses `node:tls` with certificate verification left enabled and SNI. IDLE has exponential retry and polling fallback. There is a five-task **per pass** cap and attachment limits, but no hourly admission quota. Runtime composition directly maps `resolveWebhookSessionId` to the task runner, with no explicit non-incognito/taint/refuse posture. Offline scheduler composition and live IDLE teardown need integration proofs. `collect` decodes whole parts before the saved attachment limit and calls `htmlToMarkdown` directly; the byte/time budgets of the fork extractor must carry through this path.

## Reproduction and fork adaptation

Use a disposable checkout of this PR, with the listed upstream objects and `npm ci`, then run `./docs/reviews/b5a-reproduce.ps1`. It applies the test patch, copies only the candidate IMAP modules and config leaf, exposes pure MIME helpers from the **fork's current** extractor, and adapts the candidate's array `.map` to `Array.from` for the fork's streaming multipart generator. These are test-only compatibility adaptations; #240 and later budgets are retained. No bootstrap or HTTP route is wired. The test deliberately exits nonzero on the six assertions above.

The shipped `src/tasks/b5a-imap-deferred.test.ts` rejects `source: "imap"` and pins absence of the connection, credential and scheduler entry points. The #1702 prerequisite is deferred with #1719, so it does not change existing Atomic Mail tasks in isolation.

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

Required focused suite: **5758 passed, 13 failed, 6 skipped**. All **2** new absence tests pass. Comparing file and full test name against main's full run gives **13 common failures and 0 additional names**. Main full: **30639 passed, 85 failed, 658 skipped**. The reports normalize path separators and checkout/user-home prefixes; they preserve test identities and suite errors. [Machine-readable verification](b5a-verification.json).
