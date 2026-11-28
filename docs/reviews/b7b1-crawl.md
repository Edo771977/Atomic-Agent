# B7b1: crawl gzip and redirect admission

Status: current
Owner: docs/reviews/

Base: fork main `7511497b0`. Origin: `https://github.com/Edo771977/Atomic-Agent.git`; upstream: `https://github.com/AtomicBot-ai/atomic-agent.git`. Related issues: #233 and B1 limitations #266.

Post-publication review: [current DNS/start-move corrections and verification](b7b1-review-followup.md). The exact-address-set descriptions below record the initial import tree; the follow-up narrows that comparison to cross-host start admission and supersedes its blanket application to ordinary requests.

## Provenance and decision

Imported with one `git cherry-pick -x` per upstream commit: `0a076b47cc9f7a358bbf5f5d1bc3c141fb2f5417` and `520893c4562dca64c878fdc3eab133590c7cc769`. Conflicts in OS registration and page fetching preserve the fork's approval adapter, independent egress callback, policy web guard and redirect consent hook. The subsequent adaptation retains gzip and redirects and removes automatic JavaScript rendering.

The [two-commit candidate mail patch](b7b1-candidate.patch) preserves the pre-adaptation candidate (`93c5cd6e7`) for review. Apply it with `git am` in a disposable checkout from the base above, then run `npm ci`. Set `B7B1_CANDIDATE_ROOT` to that checkout and run `node --import tsx --test docs/reviews/b7b1-candidate.mjs` from this review branch. Run the same command with the final branch as the root for the absence control. Supply the root through the environment when using `--test`; a positional directory is interpreted by Node as another test target.

All requests and DNS answers in the fixtures are synthetic. No browser, external site, personal profile or credential is used. The [JS candidate log](b7b1-js-candidate.log) records one failed absence assertion online and one passing offline control: the upstream crawl invokes the supplied renderer online. The final branch [passes both absence controls](b7b1-js-final.log). This proves the integration is absent, not that a mock browser establishes OS isolation.

## Fork adaptations and coverage

The new [crawl boundary suite](../../src/tools/os/web/crawl-fork-boundary.test.ts) was run before production imports. It recorded eight failed assertions; the companion sitemap suite could not load because its new helper was absent. After the two upstream commits, six assertions still failed: DNS identity, initial/project egress, tightened egress before redirects, and the three decompressed-byte limits. The [before/adaptation record](b7b1-red-green.json) retains those outcomes; no all-green original candidate is claimed.

| Required boundary | Final behavior and test |
| --- | --- |
| Redirect 301/302/307/308 | Every request retains HTTP(S) parsing, fresh private-address rejection and curl address pinning. The matrix covers literal 127.0.0.1, cloud metadata 169.254.169.254, IPv6 ::1, a same-site name resolving privately and a file URL for each status. |
| Redirect chains | A safe same-origin middle hop followed by a private DNS answer stops before the private request. Robots redirects stay on their origin. |
| Same site after DNS | The name check is only a first filter. Every destination must have exactly the starting host's validated public address set; the same set is checked against the actual fresh curl pins, including retries. Duplicate records and record order do not change the set. Two additional tests were red before replacing the initial array-cardinality check: duplicates cannot hide a missing address, and repeating/reordering an identical public set is accepted. A different public set and a changed public answer after move admission are refused before transport. |
| B1 and project egress | Every derived URL, robot, sitemap, cache reuse and redirect checks the live `web` egress class and organization deny. The existing runtime session egress callback is retained. Configured folder constraints also apply without a runtime frame; that additional regression was observed red before its adaptation. A policy tightened after a response blocks its next hop. |
| Consent | URL-data consent runs on derived destinations before requesting the new origin's robots. A denied data-bearing redirect sends neither that page nor its robots request. This preserves B1's documented read-only `ask` behavior; it does not silently redefine `ask` as deny. |
| Gzip and partial reads | Both gzip layers have a hard 2,000,000-byte expansion cap. Compressed expansion above it is refused; large plain sitemaps keep only that many bytes. The upstream 50 MiB wire/disk guard remains. A partial UTF-8 suffix is omitted rather than replaced beyond the byte cap. |
| Offline | No DNS, curl or renderer is started for a remote crawl. The existing transport offline backstop remains. |
| Untrusted page text | Registry invocation retains `untrustedOutput: "web pages"`; the synthetic page's instruction-like text is framed as outside data. |

The exact-address-set restriction is intentionally conservative: aliases and CDNs with different public address sets can be refused even when the operator considers them one site. Crawl the target directly after reviewing it. DNS equality is not proof of common ownership; the existing name/scope filter still applies. A previously cached page does not authorize a new DNS or policy state.

## JavaScript remains deferred

The candidate renderer interface accepts a URL and timeout and returns HTML after navigation. It provides no per-subrequest authorization callback or memory budget to the crawl. Its existing domain/frame checks and final-URL SSRF backstop cannot prove pre-request admission for page fetch/XHR, images or WebSockets. Reusing the agent browser also does not by itself establish a fresh cookie store for each crawl. A final-URL check is too late for a request the page already made.

The entire JavaScript integration is deferred: rendering, its wiring and the new shell-classification module are omitted. Static page text continues through the existing extractor. The classification-module absence test was red before its removal; the modified upstream rendering tests verify that even a legacy embedding-supplied renderer is never invoked. The online/offline renderer reproduction remains available above. Fetch's existing challenge ladder is outside this import and is unchanged.

Before reopening, require the fork browser's pre-request SSRF/egress policy on every navigation/subresource/WebSocket, isolated files/cookies/profile, cancellation, timeout and memory caps, and a zero-start offline test. Add a failing test for each before implementation. No shared runner, subagent profile, session export or HTTP export file changes here.

## Verification

`npm ci`, `npm run lint`, `npm run imports:check`, `npm run typecheck:tests` and `npm run docs:check` pass. On the final behavior, the complete web selection passes **517 tests**, and the separate renderer absence script passes **2 controls**. No timeout, skip or quarantine was added.

The required broad command was executed in full:

```text
npx vitest run src/agent src/policy src/tools src/mcp src/llm src/local-llm src/tui src/http src/runtime
```

It is **not green**: **24,110 passed, 1,018 failed, 575 skipped**, plus one suite-load error. It overlapped the final corrections: three boundary assertions are the observed red cases for the later no-frame project and unique-DNS-set fixes. All three pass in the final complete web run. The load error names `crawl-js-page.test.ts`, selected before the deliberately deferred JS module/test was removed; it is absent from the final web selection. Neither event is hidden or counted as a green broad run.

The clean pinned-main complete run is **33,928 passed, 1,060 failed, 667 skipped**. The [file/name comparison](b7b1-focused-comparison.json) lists all 950 common failures, 68 additional failures and main-only differences for the selected files. Only checkout roots and slash direction are normalized. Windows restrictions and timing affect subprocess/Git, symlink and local-network fixtures; this does not automatically explain every failure.

The [paired named controls](b7b1-focused-controls.json) rerun every additional assertion with one worker on both main and the candidate; new assertions are explicitly absent on main. The [verification record](b7b1-verification.json) summarizes those outcomes and retains raw report hashes. An isolated retry passing does not change the recorded broad-run failure. The complete `npm test` comparison for the series is also recorded in B7b3. The source base remains `7511497b0`; later main `5da6478ff` has only unrelated documentation/absence-test changes and the virtual merge was clean.

Names still failing only on the candidate in that first paired control receive one [further sequential paired diagnostic](b7b1-diagnostic-controls.json), with complete default-reporter logs for [main](b7b1-diagnostic-main.log) and [the candidate](b7b1-diagnostic-b7b1.log). Original results remain above; the verification summary uses the latest result for each name.

Final named follow-up: **67 of the 68 additional assertions pass on the candidate; one fails on both main and the candidate**. All four discordant names in the first paired control pass on both checkouts in the diagnostic. No candidate-only failure remains in this isolated comparison; the original broad run remains failed.
