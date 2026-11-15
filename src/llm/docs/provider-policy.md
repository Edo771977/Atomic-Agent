# Per-folder provider constraints

Status: current (issue #33 §5)
Owner: src/llm/ ([provider-policy.ts](../provider-policy.ts))

A folder listed in `projects.constraints` may only send a session's content to the provider ids it names. The setting, its fail-closed parsing and the folder matcher belong to config ([compatibility](../../config/docs/compatibility.md#per-folder-provider-constraints), [matcher](../../config/project-constraint-match.ts)). This page is the enforcement: every request that carries session content is checked at dispatch, against the provider that would actually receive it, before anything is sent. It is not prompt wording; nothing here can be lifted by the model.

## API (for callers and later work)

- `resolveProjectConstraint(config, workingDir)` → `ProviderPolicy | undefined`: `{ key, allowedProviders, allowedEgress, matchedDir, allows(providerId), allowsEgress(class) }`, or `undefined` when no entry covers the folder. `hasProjectConstraints(config)` says whether any entry exists. `toProviderPolicyStamp` / `providerPolicyFromStamp` carry a policy through session metadata.
- `runWithProviderPolicy(policy, fn, { role })` runs `fn` in an AsyncLocalStorage frame; `currentProviderPolicy()` / `currentProviderPolicyFrame()` read it, `currentPolicyAllows(id)` answers for the frame (no frame or no policy: allowed), `runWithProviderRole(role, fn)` keeps the policy and names the caller for a refusal.
- `ProviderNotAllowedError` (code `ATOMIC_AGENT_PROVIDER_NOT_ALLOWED`), found anywhere in a cause chain by `isProviderNotAllowed` / `findProviderNotAllowed`. `assertProviderAllowed(id, { constraintsActive })` throws it; `providerPolicyRefusalFor(id, role)` returns it for callers that answer with a tool error; `noAllowedProviderError(policy, role)` is the terminal refusal.
- `tightenCurrentProviderPolicy(policy, cell?)` narrows a running frame (read taint); `intersectProviderPolicies`, `policyCovers`; a policy's optional `readFrom` names the folders a taint came from. `describeProviderRestriction` / `formatProviderRestrictionLine` word it for frontends.
- `guardProvider(provider, { constraintsActive })` wraps an `LlmProvider` so `complete`, `completeStream` and `describeImage` check first. Everything else passes through.

- `effectivePolicyForSession(sessionOrId)` ([session policy](../../runtime/session-provider-policy.ts)) is the one read every egress check makes: the running turn's (tightenable) frame when it was set for that session, else the session's folder intersected with its stored read taint (fail closed for an unknown id).

A frame with `policy: undefined` is an unconstrained folder. No frame at all while any constraint exists is a caller nobody scoped, and every guarded call refuses it (fail closed).

## Where frames come from

- `executeTurn` and `runTurn` run inside the session's frame ([session policy](../../runtime/session-provider-policy.ts)), so the turn, its tools, the goal judge, compaction, naming and reflection started from it are covered. Roles: "the main model", "a fusion worker".
- A fusion worker obeys its parent's turn: `createEphemeralSession` stamps the frame running at fan-out into `FusionWorkerMeta.providerPolicy` (`null` for an unconstrained parent). The worker's own folder, often a temp copy, is never matched. A worker without a stamp while constraints exist is refused everything.
- A session a session's tool creates obeys its caller: `tasks.schedule { newSession: true }` and `tasks.cron` provision the task's session in the caller's folder (never the runtime's) with the caller's effective policy stored as its read taint (`childSessionSeed`, [task services](../../runtime/composition/runtime-task-services.ts)); a caller that resolves to nothing gives a refuse-all taint. A recurring task whose session was deleted is not recreated while any constraint exists: it is blocked as `session_not_recreated:` (the factory could not know the original folder or taint). Fusion and these task tools are the only sessions a model can create; HTTP, CLI and channel sessions are created by an operator or a chat and are matched by their own folder.
- The fallback seam gives a call that arrives with no frame, or inside a frame set for another session, but a `sessionId` that session's policy (`effectivePolicyForSession`: its folder, stored and live read taint), never the other session's frame (a side call's `reflection:<id>`, `compaction:<id>` partition reads as `<id>`). An id that names no stored session is refused everything.

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

Chat turns: a turn whose origin is `telegram` or `discord` (swarm bots included) for a session in a constrained folder without `channels` is refused in `runTurn` before the queue and the model (`ChannelRestrictedError`); the adapters answer with the fixed `CHANNEL_RESTRICTED_NOTICE` ("This folder is restricted; open atomic-agent on the computer.") and nothing else. Because a turn can be tainted while it runs, the Telegram and Discord adapters (swarm bots use the same classes) ask again before each send ([channel egress](../../channels/channel-egress.ts), `AgentRuntime.channelSendRefusal`): progress labels and snapshots stop, and at the end the reply, its files, budget notices and failure text are replaced by the notice, once. An approval prompt routed to a chat for such a session carries only the tool and kind (`withholdApprovalDetails`: no preview, reason, resources or "Allow always" unit), and the approval-pending reminder goes generic, without the folder's name. Outside the turn's frame `effectivePolicyForSession` intersects every view of the session: the caller's object, the stored row and the running turn's object (read taint's live registry), whose taint may not be saved yet. Task reports: `TaskRunner.notifyRefusal` asks at send time, before each report and before live snapshots, through `channelNotifyRefusal`; a withheld report is logged as `task report withheld` and the result stays local. Webhooks only enqueue tasks, so their outbound side is that report. Every check reads `effectivePolicyForSession`, which takes an id or a session object, never borrows a frame set for another session, and returns the folder's policy narrowed by the read taint (providers and egress). The registry runs the read taint (`onDispatch`) before the egress guard, so a read that taints is followed by egress checks against the narrowed policy.

A stdio MCP server is a local process and stays allowed, but it can reach the network itself, which nothing here sees. Fusion workers obey the stamped policy, egress included; an older stamp without the list allows none. `image.generate` / `video.generate` are checked as provider `openrouter` above, not as egress.

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

Sampling requests go to the local llama-server client directly. A llama-server on this machine sends nothing anywhere and always serves. One at a remote `localModels.url` is refused while any constraint exists: an MCP client is shared by every session, so a sampling request belongs to no session, and the policy frame it runs in is only the one where the transport was opened (whichever turn connected the server), which is never read.

## Not covered

Egress IS refused by default: `allowedProviders` covers model, embedding and media endpoints, and `allowedEgress` the tool classes above, both against the effective policy (folder plus read taint). A tainted unconstrained session is refused egress too, unless every folder it read from allows the class (the taint carries the intersection of the `allowedEgress` lists). Still not covered, and shown as such by `atomic-agent doctor`: shell commands (`os.shell.run`), `verify.run` and skill scripts, which can run `curl` or `git push` themselves; the network use of stdio MCP servers; and a chat message folded into a turn that is already running (only a new chat turn is refused).

## Tests

[Policy and guard](../provider-policy.test.ts), [chain](../fallback/provider-policy-fallback.test.ts), [seam](../../runtime/llm-fallback-seam.test.ts), [session policy](../../runtime/session-provider-policy.test.ts), [turn frames and Fusion](../../runtime/composition/runtime-turn-service.test.ts), [escalation and judge](../../runtime/composition/runtime-tool-catalog.test.ts), [embeddings](../../memory/embeddings/embedding-policy-guard.test.ts), [memory scope](../../memory/memory-constraint-scope.test.ts), [memory tools](../../tools/memory/memory-tools-constraint-scope.test.ts), [consolidator](../../memory/consolidator/consolidator-provider-policy.test.ts), [backfill](../../memory/embeddings/embedding-backfill.test.ts), [taint frame](../provider-policy-taint.test.ts), [read taint](../../runtime/session-read-taint.test.ts), [TUI](../../tui/provider-restriction.test.tsx), [HTTP](../../http/route-session-provider-restriction.test.ts), [MCP sampling](../../mcp/mcp-sampling-handler.test.ts), [egress inventory and guard](../../tools/tool-egress.test.ts), [egress before hooks and approval](../../agent/dispatch/batch-scheduler-egress.test.ts), [MCP classes](../../runtime/composition/runtime-egress-guard.test.ts), [chat turns](../../runtime/composition/runtime-turn-service.test.ts), [task reports](../../tasks/task-runner.test.ts).
