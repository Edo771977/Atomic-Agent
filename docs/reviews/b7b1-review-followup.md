# B7b1 review corrections

Status: current
Owner: docs/reviews/

PR #295, existing branch `codex/b7b1-crawl`. Main `54f81900b` was merged before these corrections. The [initial review](b7b1-crawl.md) and its reports retain the original behavior and verification history; the corrections below supersede its blanket exact-DNS-set rule.

## 1. Public DNS rotation on the current host

The identity comparison now applies only while admitting a start move to a different host, including that host's robots preflight and transport. Once admitted, requests on the current host allow public address changes. Every fresh DNS answer still passes the complete SSRF guard before its addresses are pinned to curl; retry and cache checks remain in place.

[DNS rotation tests](../../src/tools/os/web/crawl-dns-rotation.test.ts) first ran red: 6 passed / 4 failed, covering public round-robin, IPv4-to-dual-stack, retry and cache. The expanded pre-code run also failed the new test for rotation after a host move. Both parity cases passed against clean main `54f81900b` with the identical fixture. After the correction, the DNS and existing boundary suites pass. [Recorded red/green and main control](b7b1-review-dns.json).

The negative fixtures retain mixed public/private answers, loopback, metadata, retries and cache checks. Existing redirect status/chain, DNS identity, policy, consent, offline and framing tests remain. README clarifications distinguish whole-sitemap compressed rejection with "possible gzip bomb" from partial plain reads, and derived-page URL-data consent when a dangerous adapter is supplied. JavaScript remains deferred.

## 2. Moved-host robots failures become a tool report

`moveStart` now catches both destination admission and the `robotsFor` call, including its second authorization. Failure records the refused URL, error and explanatory note, stops with `start-moved`, and leaves the current scope unchanged. No rejected destination is connected or read. A simulated failure of the robots transport also becomes a report instead of an unhandled rejection.

Four [boundary regressions](../../src/tools/os/web/crawl-fork-boundary.test.ts) were observed red before this change: changed public DNS before robots, synthetic DNS failure, B1 denial installed between admission and robots, and the robots reader throwing. The last case records an attempted synthetic transport to an admitted host, not a successful real connection. The first three assert no transport to the refused destination. After the change all 40 boundary tests and 10 rotation tests pass. [Red/green evidence](b7b1-review-robots.json).

## 3. Initial scheme and port changes

The optional restriction is confined to `startMoveAllowed`: HTTP(S) stays on the same scheme or upgrades HTTP to HTTPS. Ports must remain effectively equal or become the destination scheme's default. Equality uses effective ports, so an HTTP-to-HTTPS upgrade may keep port 80; changing 8080 to HTTPS port 80 is refused. These checks precede host equivalence and destination robots admission.

The [scope matrix](../../src/tools/os/web/crawl-scope.test.ts) and two real-tool boundary cases observed 10 failed assertions on the preceding source; the source bytes were restored after that pre-change control. All 69 tests in scope, boundary and DNS suites then passed. [Red/green evidence](b7b1-review-scope.json). The README documents this choice and the error-report behavior.
