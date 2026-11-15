# Per-folder provider constraints

Status: current (issue #33 §5)
Owner: src/llm/ ([provider-policy.ts](../provider-policy.ts))

A folder listed in `projects.constraints` may only send a session's content to the provider ids it names. The setting, its fail-closed parsing and the folder matcher belong to config ([compatibility](../../config/docs/compatibility.md#per-folder-provider-constraints), [matcher](../../config/project-constraint-match.ts)). This page is the enforcement: every request that carries session content is checked at dispatch, against the provider that would actually receive it, before anything is sent. It is not prompt wording; nothing here can be lifted by the model.

## API (for callers and later work)

- `resolveProjectConstraint(config, workingDir)` → `ProviderPolicy | undefined`: `{ key, allowedProviders, matchedDir, allows(providerId) }`, or `undefined` when no entry covers the folder. `hasProjectConstraints(config)` says whether any entry exists. `toProviderPolicyStamp` / `providerPolicyFromStamp` carry a policy through session metadata.
- `runWithProviderPolicy(policy, fn, { role })` runs `fn` in an AsyncLocalStorage frame; `currentProviderPolicy()` / `currentProviderPolicyFrame()` read it, `currentPolicyAllows(id)` answers for the frame (no frame or no policy: allowed), `runWithProviderRole(role, fn)` keeps the policy and names the caller for a refusal.
- `ProviderNotAllowedError` (code `ATOMIC_AGENT_PROVIDER_NOT_ALLOWED`), found anywhere in a cause chain by `isProviderNotAllowed` / `findProviderNotAllowed`. `assertProviderAllowed(id, { constraintsActive })` throws it; `providerPolicyRefusalFor(id, role)` returns it for callers that answer with a tool error; `noAllowedProviderError(policy, role)` is the terminal refusal.
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

## Not covered

`allowedProviders` covers model, embedding and media endpoints only. Other egress (web fetch and search, `os.http.request`, the browser, remote MCP servers, Composio, GitHub, channels, mail, shell commands) is not constrained by it; an `allowedEgress` list is a follow-up. MCP sampling talks to the local llama-server client directly, outside the registry, and is not checked. Memory scoping (tagging rows written under a constraint), read taint from files inside a constrained folder and the TUI chip are separate work. Background jobs with neither a frame nor a session id (the memory consolidator's timer) are refused while constraints exist.

## Tests

[Policy and guard](../provider-policy.test.ts), [chain](../fallback/provider-policy-fallback.test.ts), [seam](../../runtime/llm-fallback-seam.test.ts), [session policy](../../runtime/session-provider-policy.test.ts), [turn frames and Fusion](../../runtime/composition/runtime-turn-service.test.ts), [escalation and judge](../../runtime/composition/runtime-tool-catalog.test.ts), [embeddings](../../memory/embeddings/embedding-policy-guard.test.ts).
