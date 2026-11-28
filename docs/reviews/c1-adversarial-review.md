# C1 adversarial review

Status: current
Owner: docs/reviews/

This is the implementation agent's adversarial pass, not an independent reviewer approval. The [pre-import failures](c1-fail-before.json) and per-slice reviews distinguish new behavior from preserved fork controls.

## Attempts to widen the imported surface

- Applying C1a verbatim would drop the fork's full operator request and provider policy from the constructed stamp. The conflict adaptation retains both, including egress/host restrictions and fail-closed malformed policy. The resolved type requires depth only; optional fork fields do not become fictitiously required. The depth boundary tests verify the preserved data and ancestry.
- Authorizing a local model by origin alone would accept a forged subagent origin. The fork's worker-stamp and known-model checks are retained. The turn-service test refuses the unstamped caller and permits properly stamped Fusion/subagent callers with a configured model.
- Upstream's origin inventory misses the fork's experience reviewer. A failing test reproduces draft instead of skip; the adaptation excludes subagent turns there as well as in analytics and suggestions.
- Moving runner types could discard fork-only hooks. The extraction preserves original-project rules, request-budget binding, declared inputs, taint, workspace trust, task permits, verification/integrity, watch and project lesson fields. The execution body retains its await points and dispatch dependencies. A new core test uses the actual registry and organization policy to refuse the same synthetic command for parent and worker, with zero adapter executions.
- A settings profile with an unknown tool was accepted by the upstream loader. The failing admission test covers a mixed known/unknown list, a forbidden memory write, a wildcard that includes forbidden screen control and a malformed alias. Runtime catalog validation reserves rejected names. The [second review](c1-review2-corrections.md) reverses the unsafe first-review fallback and makes source/tool warnings visible in the result; built-ins still safely omit unavailable optional tools, and explicit empty lists are rejected rather than widened.
- Fresh config reads do not write a live session or its stable prefix. Tests exercise two on-disk edits and compare the complete prefix bytes. Project profile file discovery and trust decisions remain on their existing path. No configuration-write or secret-management route is added.

## Execution remains deferred

The [C1e audit](c1e-subagent-run.md) reproduces unaccounted cloud work under a hard cap and eviction of an active turn's child count, with three controls passing on actual candidate modules. Its 15 commits are confined to the disposable upstream review checkout. The fork exposes no subagent tool, catalog entry or production grammar verb.

Consequently this change does not claim end-to-end subagent approval routing, isolated always grants, write-grant lifetime/canonicalization, subprocess restrictions, incognito formation, every provider/privacy leg or process-tree cancellation. Those remain explicit reopening requirements; three candidate-red/fork-green absence assertions prevent accidentally enabling an unaudited execution surface. Existing Fusion controls stay in place.

The [source parity record](c1-source-parity.json) verifies that rebasing onto the newer main changed no production source: only the parallel series' documentation and absence tests were added. No export, crawl, tool-name-resolution or external llama.cpp probe implementation is modified. The PR explicitly identifies the shared Fusion runner file.
