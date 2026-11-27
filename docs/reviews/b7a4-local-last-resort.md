# B7a4 local last-resort question

Status: current
Owner: docs/reviews/

Deferred without production changes or imported commits. Reviewed f72e0a38446352115cde15cebe42c4ffadee498d and e753f8307c5199c4ac996fe9f2afa8424558f93a against fork main 904476e2e099903833223beb4a0ace08b8d7a220. The second commit adds README metadata and a mouse-test stub only.

Reproduction requires `npm ci` and the upstream objects: fetch `upstream main` from `https://github.com/AtomicBot-ai/atomic-agent.git` if they are not available locally.

Run node --import tsx --test docs/reviews/b7a4-candidate.mjs. Three assertion failures cover the trust boundary: two direct-owner calls let a marked child record keep as operator consent and change appendLocal to false for off. The whole upstream persistence owner and its config setter are evaluated with real temporary files and the fork's actual config validation/write helpers. The third test is the #235 control: it loads the complete upstream HTTP handler into the real fork listener with an explicit admin scope, spawns a Node child with ATOMIC_AGENT_TOOL_CHILD=1 and an inherited synthetic owner key, and receives 200 instead of 403. Config appendLocal becomes false and the answer file is created. The endpoint exists only in this disposable audit server, never in the production route table. The candidate HTTP POST delegates to this owner without any independent operator decision. It accepts valid owner credentials just as the deferred #235 surface did; adding an admin scope does not distinguish an agent carrying the inherited owner key. The candidate route does not add ROUTE_SCOPES entries. No argv approval or server-side environment flag establishes the remote caller's identity.

The passing absence regression uses the real fork HTTP listener with owner/admin/operator/member/viewer/anonymous identities, an inherited owner credential in a marked child, offline on/off and malformed input. GET and POST stay 404; config bytes and directory contents stay unchanged. Existing manual fallback settings and provider policy are untouched.

Before reopening: an operator-mediated, non-grantable consent decision must reject agent writes including inherited-key HTTP, direct owner and CLI calls. Explicitly register status and mutation scopes, with POST admin, in ROUTE_SCOPES and http-scopes.test.ts. Test once-only asking, explicit consent before persistence and concurrent/stale answers. Exercise a constrained folder through actual fallback resolution: allowed and forbidden local/remote providers, offline, read taint and per-call Privacy Shield; do not change src/policy or Fusion promotion in this import. These enabled-feature guarantees are unproven and remain the reopening requirement.

## Verification results

The [verification record](b7a4-verification.json) preserves upstream provenance, red/green controls and initial attempts plus final retries. All final setup/static/documentation checks pass. The [name-by-name comparison](b7a4-comparison.json) uses the same main baseline and preserves every initial failure.

Requested focused suite: **12980 passed, 25 failed, 38 skipped**. 24 initial failures match main's complete run by file and full test name; 1 additional names are accounted for by the recorded controlled reruns. No additional failure remains unresolved. Every new test passes.

Main's complete run: **30572 passed, 157 failed, 658 skipped**. A failed baseline test that passes here is recorded without attributing a fix to this feature. These reports do not claim an entirely green suite.

The one additional cleanup name also fails in the paired main control and passes in the later selected main control, documenting its environment sensitivity. No production cleanup code is changed.
