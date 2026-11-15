# Per-folder provider constraints

Status: current (issue #33 §5)
Owner: src/llm/ ([provider-policy.ts](../provider-policy.ts))

A folder listed in `projects.constraints` may only send a session's content to the provider ids it names. The setting, its fail-closed parsing and the folder matcher belong to config ([compatibility](../../config/docs/compatibility.md#per-folder-provider-constraints), [matcher](../../config/project-constraint-match.ts)). This page is the enforcement: every request that carries session content is checked at dispatch, against the provider that would actually receive it, before anything is sent. It is not prompt wording; nothing here can be lifted by the model.

## API (for callers and later work)

- `resolveProjectConstraint(config, workingDir)` → `ProviderPolicy | undefined`: `{ key, allowedProviders, allowedEgress, matchedDir, allows(providerId), allowsEgress(class) }`, or `undefined` when no entry covers the folder. `hasProjectConstraints(config)` says whether any entry exists. `toProviderPolicyStamp` / `providerPolicyFromStamp` carry a policy through session metadata.
- `runWithProviderPolicy(policy, fn, { role })` runs `fn` in an AsyncLocalStorage frame; `currentProviderPolicy()` / `currentProviderPolicyFrame()` read it, `currentPolicyAllows(id)` answers for the frame (no frame or no policy: allowed), `runWithProviderRole(role, fn)` keeps the policy and names the caller for a refusal.
- `ProviderNotAllowedError` (code `ATOMIC_AGENT_PROVIDER_NOT_ALLOWED`), found anywhere in a cause chain by `isProviderNotAllowed` / `findProviderNotAllowed`. `assertProviderAllowed(id, { constraintsActive })` throws it; `providerPolicyRefusalFor(id, role)` returns it for callers that answer with a tool error; `noAllowedProviderError(policy, role)` is the terminal refusal.
- `guardProvider(provider, { constraintsActive })` wraps an `LlmProvider` so `complete`, `completeStream` and `describeImage` check first. Everything else passes through.

- `effectivePolicyForSession(sessionId)` ([session policy](../../runtime/session-provider-policy.ts)) is the one read the egress guard makes: the running turn's frame, else the session's folder (fail closed). A rule that narrows a session mid-turn (a read taint) extends it there.

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

## Egress (`allowedEgress`)

A constrained folder's tools may not send its content off the machine unless the entry's `allowedEgress` names their class; the default is none. The [tool registry](../../tools/tool-registry.ts) runs the guard ([inventory](../../tools/tool-egress.ts), [runtime wiring](../../runtime/composition/runtime-egress-guard.ts)) before the call: the batch scheduler asks `refusalBeforeDispatch` ahead of PreToolUse hooks and the approval ledger, and `invoke` checks again, so a refused call never prompts and never sends. The refusal (code `ATOMIC_AGENT_EGRESS_NOT_ALLOWED`) reads `folder <key> is restricted: <tool> would send content off this machine; add "<class>" to projects.constraints["<key>"].allowedEgress to allow it`.

| Class | Tools |
| --- | --- |
| `web` | `os.web.search`, `os.web.fetch` (a loopback URL stays allowed) |
| `http` | `os.http.request` (a loopback URL stays allowed) |
| `browser` | every `browser.*` tool, local dev pages included: a local page can still load remote resources, and the page acted on may be remote whatever the arguments say. List `browser` to use a local page |
| `github` | `github.*` |
| `git` | `os.git.fetch`, `pull`, `push`, `clone` |
| `mail` | `os.email.*` (Atomic Mail) |
| `channels` | `tasks.schedule` / `tasks.cron` with `notify`; a turn sent from Telegram, Discord or a swarm bot; a task's report and live snapshots |
| `composio` | tools of the Composio MCP server |
| `mcp:<server>` | tools of a remote (http, SSE) MCP server, and `mcp.resource.*` / `mcp.prompt.*` naming it; a tool whose server is unknown counts as remote |

Chat turns: a turn whose origin is `telegram` or `discord` (swarm bots included) for a session in a constrained folder without `channels` is refused in `runTurn` before the queue and the model (`ChannelRestrictedError`); the adapters answer with the fixed `CHANNEL_RESTRICTED_NOTICE` ("This folder is restricted; open atomic-agent on the computer.") and nothing else. Task reports: `TaskRunner.notifyRefusal` asks at send time, before each report and before live snapshots, through `channelNotifyRefusal`; a withheld report is logged as `task report withheld` and the result stays local. Webhooks only enqueue tasks, so their outbound side is that report. Every check reads `effectivePolicyForSession`, which takes an id or a session object and never borrows a frame set for another session.

A stdio MCP server is a local process and stays allowed, but it can reach the network itself, which nothing here sees. Fusion workers obey the stamped policy, egress included; an older stamp without the list allows none. `image.generate` / `video.generate` are checked as provider `openrouter` above, not as egress.

## Not covered

`allowedProviders` covers model, embedding and media endpoints; `allowedEgress` covers the tool classes above. Not covered, and shown as such by `atomic-agent doctor`: shell commands (`os.shell.run`, `verify.run`, skill scripts), which can run `curl` or `git push` themselves, and the network use of stdio MCP servers. MCP sampling talks to the local llama-server client directly, outside the registry, and is not checked. Memory scoping (tagging rows written under a constraint), read taint from files inside a constrained folder and the TUI chip are separate work. Background jobs with neither a frame nor a session id (the memory consolidator's timer) are refused while constraints exist.

## Tests

[Policy and guard](../provider-policy.test.ts), [chain](../fallback/provider-policy-fallback.test.ts), [seam](../../runtime/llm-fallback-seam.test.ts), [session policy](../../runtime/session-provider-policy.test.ts), [turn frames and Fusion](../../runtime/composition/runtime-turn-service.test.ts), [escalation and judge](../../runtime/composition/runtime-tool-catalog.test.ts), [embeddings](../../memory/embeddings/embedding-policy-guard.test.ts), [egress inventory and guard](../../tools/tool-egress.test.ts), [egress before hooks and approval](../../agent/dispatch/batch-scheduler-egress.test.ts), [MCP classes](../../runtime/composition/runtime-egress-guard.test.ts), [chat turns](../../runtime/composition/runtime-turn-service.test.ts), [task reports](../../tasks/task-runner.test.ts).
