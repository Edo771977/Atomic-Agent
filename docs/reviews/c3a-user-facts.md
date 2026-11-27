# C3a: facts extracted from chat exports

Status: current
Owner: docs/reviews/

Deferred under #233. Base: origin/main `104b6f7e6e111c017cff530c8c135899c2614db0`. Verified remotes: origin `https://github.com/Edo771977/Atomic-Agent.git`, upstream `https://github.com/AtomicBot-ai/atomic-agent.git`. No production code is imported. C3b, C3c and C3d depend on this slice and must also stay deferred.

## Candidate and reproduction

In a disposable checkout from that base, run `git cherry-pick -x d093ba6a44b31206fef888121060fa80472d2b1b`, then `npm ci`. It applies without conflicts. Each upstream commit remains a separate provenance-bearing commit in the review checkout; none enters the deferral branch.

The [preparation script](c3-prepare-candidate.ps1) reproduces the pinned base and the whole chain; use `-Through a` for this slice. A later run of the C3a audit after the C3b picks produced the same six failures; those commits do not change the tested C3a owners.

Set `C3_CANDIDATE_ROOT` to that checkout and run `node --import tsx --test docs/reviews/c3a-candidate.mjs` from this branch. The [script](c3a-candidate.mjs) imports the actual candidate collector, extractor, saver and fork SQLite stores. It uses disposable synthetic data, intercepts inference with deterministic output, registers a synthetic opaque ingress key with the real runtime secret inventory, and never contacts a provider. Cleanup removes only the directory returned by mkdtemp.

The [candidate result](c3a-candidate.log) records 10 tests: four controls pass and six safety assertions fail:

- A process marked ATOMIC_AGENT_TOOL_CHILD saves an approved profile fact. A supplied list of IDs does not establish person-mediated approval. The inherited-owner-key HTTP case belongs to C3b; no invented environment key is treated as an authentication mechanism here.
- The collector keeps an opaque credential known to runtimeKnownSecrets. The same credential is not considered sensitive as a candidate. The control proves that the fork detector masks it when given its runtime inventory.
- The prompt reaching the completion seam has headings but no explicit instruction to treat exported conversation as untrusted data or to ignore instructions inside it. This is a framing assertion, not a claim that a particular model obeyed a malicious message.
- The extractor accepts a profile value longer than its documented 200-character limit and accepts seven output lines despite its documented six-line limit. Prompt wording does not enforce either bound.

Passing controls establish that an empty approval list writes nothing (including a synthetic injection string), undo leaves unrelated facts and later profile edits intact, an existing provider-policy frame scopes actual SQLite writes, and cloud without run consent makes no completion call. These controls do not establish end-to-end policy propagation in a new background service.

The [absence regression](../../src/import/facts-extraction-deferred.test.ts) fails all three tests on the candidate ([red report](c3a-absence-red.json)) and passes on the deferral. This is candidate-red/deferral-green evidence, not an enabled feature or a main-red implementation test.

## Before reopening

Observe a failing test for each requirement before implementing its adaptation:

- Require explicit approval bound to the exact candidates and a person-controlled operation. Refuse agent children; an inherited bearer cannot serve as proof of human approval (#235/#260). Cover direct service calls and subprocess HTTP calls separately.
- Keep candidates and their backing quotes in process memory until approval. Exercise disk, logs, reports, errors, stop, shutdown and expiration with sentinel text; persist only approved facts and a minimal undo receipt.
- Carry the export's read/constraint scope through extraction, save and undo. Test same-key and foreign-key visibility, disabled rows and every relevant memory-enabled switch against actual stores. Existing scoped SQLite behavior is retained, not replaced.
- Feed the shared detector runtimeKnownSecrets on input, candidates, quotes and save. A known opaque key must neither reach inference nor appear as a candidate, durable fact, diagnostic or report. Preserve store-level secret refusal as defense in depth.
- Enforce hard per-import candidate counts and per-kind lengths after parsing and again before persistence. The six-line/200-character checks here use the upstream documented promises; add a separately specified total-import cap rather than relying on message limits.
- Frame all exported text as untrusted data, with tools unavailable. Model instructions inside a chat must never authorize a save; test a malicious exported message with an empty person decision.
- Keep undo transactional and restricted to rows created by the receipt; preserve unrelated imports, later edits, constraint scopes and disabled state.

C3a contains an in-memory ChatGPT projection, not a filesystem/zip reader. Archive traversal, symlink containment, bomb, entry-count, JSON-size/depth, read scope and input-file protection tests are mandatory on C3b's actual reader before either slice is enabled. Absence of that reader here is not evidence that archives are safe.

## Verification

See [verification record](c3a-verification.json) for the required setup, static checks and full requested focused selection. Failures are recorded by name against clean main. No policy, agent/step, Fusion, subagent, session/chat-export or route-session-export file is changed.

Setup, lint, imports:check, typecheck:tests and docs:check pass. The full six-area selection records 12,380 passes, one failure and 12 skips. All three new absence assertions pass. The one failure is VoteStore's 1,000-row transaction timing assertion. Paired two-worker controls reproduce that exact failed name on both main (12 pass, one fail) and this branch (15 pass, one fail, including all three new absence assertions). No threshold is raised and no unrelated implementation is changed. The [name comparison](c3a-focused-comparison.json) records this existing failure; no entirely green suite is claimed. The complete npm test comparison is supplied with the final dependent C3d PR.
