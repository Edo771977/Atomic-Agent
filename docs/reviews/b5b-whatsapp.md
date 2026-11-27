# B5b: defer WhatsApp Web channel (#1672)

Status: current
Owner: docs/reviews/

Deferred with no production or dependency changes. Fork main baseline: `6dd01db055bc5b2f0d186f037b1ad10bf4fae28e`. Reviewed [upstream commit and parent](b5b-upstream-commits.json): `7294526df588c40f60fae7873b95dfd248bbb6f4`.

## Supply chain decision

The user explicitly requires deferral if npm would execute new install scripts. The candidate lock adds **87 package entries**, including `baileys@7.0.0-rc14` and `protobufjs@7.6.6` with `hasInstallScript`. Registry metadata confirms Baileys `preinstall: node ./engine-requirements.js` and protobufjs `postinstall: node scripts/postinstall`. **Neither script was executed.** The fork's ordinary `npm ci --foreground-scripts` executes only its already-present esbuild postinstall. [Lock delta and exact versions](b5b-lock-delta.json), [Baileys registry metadata](b5b-baileys-metadata.json), [protobufjs scripts](b5b-protobufjs-scripts.json).

Metadata was read on 27 November 2026 with `npm view baileys@7.0.0-rc14 version license repository maintainers scripts dist --json` and `npm view protobufjs@7.6.6 scripts --json`. The registry lists maintainers `purpshell`, `auties00`, `shelltear`, MIT license, and the WhiskeySockets/Baileys repository. The pinned integrity matches the lock. This identifies the publisher metadata, not a security endorsement or a maintainer account audit. The package has 401 files and 8,460,427 unpacked bytes (about 8.07 MiB), before transitive dependencies. The 87-entry delta includes the Signal implementation, protobuf, WebSocket and utility packages; its exact graph, licenses, URLs and hashes are in the delta. Optional native image dependencies also need a separate review before use; their optional install hooks are not added here.

On this host npm is 11.20.0, `ignore-scripts=false` and `strict-allow-scripts=false`. The current root allowScripts map denies better-sqlite3/fsevents and allows esbuild, with no rule for Baileys or protobufjs. Inspection of the installed npm implementation (`@npmcli/arborist/lib/script-allowed.js`, `arborist/rebuild.js`, and `npm/lib/utils/strict-allow-scripts-preflight.js`) confirms unmatched entries return null, rebuild skips only explicit false, and strict preflight does nothing unless enabled. Thus this existing map does not prevent the new hooks from executing on a normal npm ci. This conclusion is from the exact host implementation and metadata, without executing either hook.

`scripts/bundle-sea.ts` marks Baileys external because of WebAssembly/native helpers and does not copy it alongside the executable. The proposed channel therefore cannot load in the single-file binary; the bundle byte delta was not built or claimed. Baileys itself declares MIT. The graph also adds GPL-3.0 `libsignal`, LGPL-3.0-or-later libvips binaries and mixed Apache/LGPL/MIT WASM binaries. [Signal metadata](b5b-libsignal-metadata.json) confirms the GPL declaration. `qrcode-terminal` lacks the modern license field in this lock/registry metadata, but its tarball contains Apache-2.0 LICENSE and a legacy licenses array: this was verified with `npm pack --ignore-scripts`, with integrity matching the exact lock and no script execution ([artifact inspection](b5b-qrcode-metadata.json)). Full distribution compatibility and notice/source obligations have not been established, and must not be inferred from Baileys' own MIT label. Nor does a code license authorize WhatsApp service access. The [Baileys project](https://github.com/WhiskeySockets/Baileys) identifies an unofficial WhatsApp Web library; the [EEA terms effective 17 August 2026](https://www.whatsapp.com/legal/terms-of-service-eea) restrict unauthorized automated access and reverse engineering. Compatibility of this intended automation has not been established. The new-install-script criterion independently decides the deferral; no definitive legal conclusion is claimed.

## Runtime and credentials evidence

[Tests](b5b-candidate-tests.patch), authored before candidate modules were copied, use a fake runtime. The stranger control passes; **3 security assertions fail**: the owner message reaches `runTurn` as raw text, and both `getTrustConfigPaths` and `getStateSecretPaths` omit the WhatsApp auth directory and QR file. [Names and outcomes](b5b-candidate-results.json). The production absence regression fails with the candidate files present. No Baileys install, QR pairing, network connection or real account was used.

The candidate uses `useMultiFileAuthState` directly on `whatsapp-auth/`, outside the fork's validated credential owner. The auth directory requests 0700 and the QR file requests 0600, but that is insufficient for the protected-path and child-access contract. The silent Baileys logger is a good control, and QR text is written to a file rather than logged; error/trace sinks and fallback QR handling still need sentinel tests. Raw owner text is not framed and the handler has no explicit read-taint or per-send `channel-egress` check. The allowlist and alternate JIDs need transport-backed verification, session attribution and cancellation/steer race tests. The short-code approval bridge must preserve the fork's owner-only decision posture, including worker session attribution.

Reproduce in a disposable checkout of this PR with dependencies installed and the upstream object present: `./docs/reviews/b5b-reproduce.ps1`. It copies only the candidate modules and invokes the fake-runtime tests. It does not install the new dependencies, register the channel, or alter `turn-controller.ts`. Expected: 1 control passes, 3 assertions fail.

The shipped `src/channels/b5b-whatsapp-deferred.test.ts` pins no catalog selection, connector, QR/auth handler, inbound/approval handler or lockfile dependencies. The fork's `runtime.runTurn`, FIFO, cancellation and approvals are unchanged.

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

Required focused suite: **5759 passed, 13 failed, 6 skipped**. All **3** new absence tests pass. Comparing file and full test name against main's full run gives **13 common failures and 0 additional names**. Main full: **30639 passed, 85 failed, 658 skipped**. The reports normalize path separators and checkout/user-home prefixes; they preserve test identities and suite errors. [Machine-readable verification](b5b-verification.json).
