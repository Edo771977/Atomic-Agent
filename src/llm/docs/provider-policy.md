# Per-folder provider constraints

Status: current (issue #33 §5)
Owner: src/llm/ ([provider-policy.ts](../provider-policy.ts))

A folder listed in `projects.constraints` may only send a session's content to the provider ids it names. The setting, its fail-closed parsing and the folder matcher belong to config ([compatibility](../../config/docs/compatibility.md#per-folder-provider-constraints), [matcher](../../config/project-constraint-match.ts)). This page is the enforcement: every request that carries session content is checked at dispatch, against the provider that would actually receive it, before anything is sent. It is not prompt wording; nothing here can be lifted by the model.

## API (for callers and later work)

- `resolveProjectConstraint(config, workingDir)` → `ProviderPolicy | undefined`: `{ key, allowedProviders, matchedDir, allows(providerId) }`, or `undefined` when no entry covers the folder. `hasProjectConstraints(config)` says whether any entry exists. `toProviderPolicyStamp` / `providerPolicyFromStamp` carry a policy through session metadata.
- `runWithProviderPolicy(policy, fn, { role })` runs `fn` in an AsyncLocalStorage frame; `currentProviderPolicy()` / `currentProviderPolicyFrame()` read it, `currentPolicyAllows(id)` answers for the frame (no frame or no policy: allowed), `runWithProviderRole(role, fn)` keeps the policy and names the caller for a refusal.
- `ProviderNotAllowedError` (code `ATOMIC_AGENT_PROVIDER_NOT_ALLOWED`), found anywhere in a cause chain by `isProviderNotAllowed` / `findProviderNotAllowed`. `assertProviderAllowed(id, { constraintsActive })` throws it; `providerPolicyRefusalFor(id, role)` returns it for callers that answer with a tool error; `noAllowedProviderError(policy, role)` is the terminal refusal.
- `tightenCurrentProviderPolicy(policy, cell?)` narrows a running frame (read taint); `intersectProviderPolicies`, `policyCovers`; a policy's optional `readFrom` names the folders a taint came from. `describeProviderRestriction` / `formatProviderRestrictionLine` word it for frontends.
- `guardProvider(provider, { constraintsActive })` wraps an `LlmProvider` so `complete`, `completeStream` and `describeImage` check first. Everything else passes through.

A frame with `policy: undefined` is an unconstrained folder. No frame at all while any constraint exists is a caller nobody scoped, and every guarded call refuses it (fail closed).

## Where frames come from

- `executeTurn` and `runTurn` run inside the session's frame ([session policy](../../runtime/session-provider-policy.ts)), so the turn, its tools, the goal judge, compaction, naming and reflection started from it are covered. Roles: "the main model", "a fusion worker".
- A fusion worker obeys its parent's turn: `createEphemeralSession` stamps the frame running at fan-out into `FusionWorkerMeta.providerPolicy` (`null` for an unconstrained parent). The worker's own folder, often a temp copy, is never matched. A worker without a stamp while constraints exist is refused everything.
- The fallback seam gives a call that arrives with no frame but a `sessionId` that session's policy, re-derived from its stored folder (a side call's `reflection:<id>`, `compaction:<id>` partition reads as `<id>`). An id that names no stored session is refused everything.

## What is enforced

- Every provider the registry builds is wrapped by `guardProvider`, so direct `getProvider(id)` callers are covered: escalation ("fusion escalation"), the judge ("the fusion judge"), the local format check ("the fusion format check"), `vision.describe` (`describeImage`), subscription CLIs (they are providers). The escalation seam and format check also check explicitly before the spend ceiling.
- The fallback seam checks the asked id before `prepareLink` (no warm-up for a refused link) and again the id of the provider `resolveSlice` returned, since an unknown id resolves to the active provider.
- The chain ([fallback](fallback.md)) drops every link the frame's policy does not allow, primary included, and starts on the first allowed one. A refusal advances without the immediate signal, records no breaker failure, cooldown or sticky override, classifies as `transport` and is never an outage (no provider wait). With no allowed link left the call fails with `folder <key> is restricted to: <ids>; no allowed provider can serve <role>`.
- The model router ([router](../router/README.md)) never picks a provider the folder does not allow.
- Fusion: the orchestrator not allowed but the worker leg allowed → the turn runs pinned to the worker leg as a single model and `fusion.delegate` is hidden and refused; only the orchestrator allowed → it works alone without `fusion.delegate`; neither → no fan-out, and the chain refuses unless another allowed link exists ([degradation](../../runtime/fusion-policy-degradation.ts)).
- Memory embeddings are judged by place, not id: an endpoint on this machine (loopback URL, or Atomic Core's embedding module) is always allowed; any other is refused in a constrained folder as `EmbeddingUnavailableError`, so recall falls back to full-text search and nothing is sent ([guard](../../memory/embeddings/embedding-policy-guard.ts)).
- Core-proxied media (`image.generate`, `video.generate`, and Core's OpenRouter key registration as a backstop) is refused unless the folder allows `openrouter`, where Core sends the job.

## Memory scoping

Durable memory is shared by every session, so a row written while a constraint governs the call (a note from the notes tool, reflection or a memory flush, a lesson or procedure, a profile fact, a reconciler's write) carries that constraint in its own `constraint_scope` column: `{key, allowedProviders}` frozen at write time ([scope](../../memory/memory-constraint-scope.ts)). It is a column, not a tag, so the notes tool, reflection EVOLVE and the reconciler cannot add or strip it. Every read (recall, hybrid recall, the memory and lesson indexes, link expansion, lessons, procedures, profile injection, `memory.notes.recall { id }`) passes through `memory_scope_visible()`, a SQLite function that reads the call's frame:

- an untagged row is visible to every call;
- a tagged row is visible to a policy with the same key, or a stricter one (its allowed list a subset of the row's: the content could only reach providers its own folder already allowed);
- a call with no policy (an unconstrained folder, a CLI, an unscoped job) sees untagged rows only.

Dedup never merges a write into a row of another scope. A profile write never supersedes a fact of another scope; it is refused with a validation error, and `memory.profile.remove` / `memory.notes.forget` cannot delete what the session cannot see. Writes themselves are not refused: the providers they use (reflection model, embeddings) are already checked at dispatch, so tagging is enough. A row written by an older binary is untagged. Removing a constraint from config does not untag its rows; they stay visible only to sessions of that key.

## Background jobs

The memory consolidator's timer and the embedding backfill (startup and `memory reindex`) have neither a frame nor a session. They work per row scope instead of being refused: one pass for untagged rows with no constraint, and one per constrained scope, under that row's own policy (`runInMemoryRowScope`), which sees and writes exactly that scope. A distill call a scope's policy refuses leaves its clusters as they were (`clustersSkippedByPolicy`); a note whose embedding endpoint is refused keeps no vector (`notAllowed`) and the run goes on. The deprecation sweep and vote decay send nothing and run over every row.

## Read taint

A session that reads files inside a constrained folder carries that folder's constraint from then on ([read taint](../../runtime/session-read-taint.ts)). The tool registry tells the runtime before a tool runs (`onDispatch`); the read targets are those the read scope knows (fs read, list, grep, glob, read_document, archives, git reads, `vision.describe`, `file://` pages, syntax checks) plus an `os.shell.run` command's `cwd` and its absolute paths. When a target falls under a constraint the session's policy does not already carry:

- the turn's frame is narrowed at once (frames hold one tightenable policy cell shared by nested role frames), so the read tool itself and the next model call must satisfy it;
- the taint is stored in the session metadata (`providerReadTaint`), so the next turn, side calls by session id and `/resume` keep it; the session's policy is its folder's intersected with it;
- several folders give the intersection of their lists; a Fusion worker's read taints its orchestrator's turn.

A refused call then reads `this session read files from <folder>, which is restricted to: <ids>`. A read the read scope refuses still taints (fail closed). A relative shell path from a `cwd` outside the folder, or a computed one, is not detected. Memory written after the taint is scoped to the tainted policy.

## Status

`describeProviderRestriction(policy)` gives `{label, allowedProviders, folder, readFrom}` (`restricted to: local-llama`). The TUI draws the label as a chip after the composer's route and adds a `Providers:` line to `/status`; the sidecar answers `get_provider_restriction {sessionId}` and `serve` answers `GET /api/sessions/{id}/provider-restriction`, `null` when nothing applies.

## MCP sampling

Sampling requests go to the local llama-server client directly. A llama-server on this machine sends nothing anywhere and always serves. One at a remote `localModels.url` is checked as `local-llama` against the request's frame, and refused while constraints exist when there is none (a sampling request arrives from the MCP transport, not a turn).

## Not covered

`allowedProviders` covers model, embedding and media endpoints only. Other egress (web fetch and search, `os.http.request`, the browser, remote MCP servers, Composio, GitHub, channels, mail, shell commands) is not constrained by it; an `allowedEgress` list is a follow-up.

## Tests

[Policy and guard](../provider-policy.test.ts), [chain](../fallback/provider-policy-fallback.test.ts), [seam](../../runtime/llm-fallback-seam.test.ts), [session policy](../../runtime/session-provider-policy.test.ts), [turn frames and Fusion](../../runtime/composition/runtime-turn-service.test.ts), [escalation and judge](../../runtime/composition/runtime-tool-catalog.test.ts), [embeddings](../../memory/embeddings/embedding-policy-guard.test.ts), [memory scope](../../memory/memory-constraint-scope.test.ts), [memory tools](../../tools/memory/memory-tools-constraint-scope.test.ts), [consolidator](../../memory/consolidator/consolidator-provider-policy.test.ts), [backfill](../../memory/embeddings/embedding-backfill.test.ts), [taint frame](../provider-policy-taint.test.ts), [read taint](../../runtime/session-read-taint.test.ts), [TUI](../../tui/provider-restriction.test.tsx), [HTTP](../../http/route-session-provider-restriction.test.ts), [MCP sampling](../../mcp/mcp-sampling-handler.test.ts).
