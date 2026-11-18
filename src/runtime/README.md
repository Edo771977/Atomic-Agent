# Runtime assembly and ownership

Status: current
Owner: src/runtime/

This area owns runtime assembly and ownership. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [bootstrap.ts](bootstrap.ts)
- [runtime-contract.ts](runtime-contract.ts): public types, re-exported by bootstrap for existing consumers.
- [composition/README.md](composition/README.md): internal construction phases and component owners.
- [turn-controller.ts](turn-controller.ts)
- [steering-inbox.ts](steering-inbox.ts)
- [turn-checkpoints.ts](turn-checkpoints.ts)
- [llm-fallback-seam.ts](llm-fallback-seam.ts)
- [session-provider-policy.ts](session-provider-policy.ts) and [fusion-policy-degradation.ts](fusion-policy-degradation.ts): the provider-policy frame of each turn, fusion worker stamps and what a folder constraint leaves of Fusion ([provider policy](../llm/docs/provider-policy.md)).
- [session-workspace.ts](session-workspace.ts): per-session cloud preparation; [workspace contract](docs/cloud-workspace.md).
- [session-director.ts](session-director.ts): a fusion session's director and preferred worker (issue #37); see "Fusion director" below.

## Ownership and dependencies

Bootstrap orders construction phases, assembles AgentLoop dependencies and returns the public runtime. Internal composition components hold catalog, trace, telemetry and turn state; they receive named dependencies and callbacks. They cannot import bootstrap, and consumers outside bootstrap cannot import them. TurnController owns per-session FIFO scheduling; SteeringInbox owns pending corrections. The runtime supplies live getters to consumers so a provider or tool change can take effect without rebuilding every frontend. [Lifecycle](docs/lifecycle.md) documents resource ownership, shutdown order and existing failed-start limits.

For a composer context preview, `previewPrompt` delegates to composition/runtime-prompt-preview.ts: it builds an in-memory prompt with live descriptors and the optional draft, without inference, recall prefetch or persistence. Unknown session IDs raise `SessionNotFoundError`.

The turn service captures [model behavior settings](../llm/docs/model-mode.md) once per turn, shares that snapshot with Fusion workers and reflection, and passes it to each provider attempt. Preview describes the next turn's saved settings without writing. Cloud model-visible messages are persisted before inference under the turn owner. Each cloud/fallback transition rebuilds against the attempted policy and window; the serving policy also controls tool-output retention. Local-only requests retain their existing preparation.

For tool integration read composition/runtime-tool-catalog.ts; for provider hot swap read composition/runtime-inference.ts and runtime-local-profile.ts. For sidecar locking read composition/runtime-turn-service.ts and turn-controller.ts. For memory sub-call cancellation read composition/runtime-memory-services.ts. For a channel/store shutdown race read composition/runtime-lifecycle.ts and docs/lifecycle.md. [Component routes and tests](composition/README.md) link each task to its owner.

## Fusion director

With `llm.runMode.fusion.team`, each session has its own director, stored in its metadata (`session/session-fusion-team.ts`), never in the global config. `executeTurn` reads it (`sessionDirectorChoice`; a caller's `director` / `worker` option is checked against the team and stamped first; a named worker the folder refuses is refused with the provider refusal), in the fusion mode refuses one the folder's policy refuses with the provider refusal (another mode keeps the stamp, unenforced), resolves the run mode with it (`resolveCurrentRunMode(choice)`: fusion holds whatever the active provider is), heads the session's fallback chain with it (`setTurnPrimary`, not a pin) and asks its link for its model (`turnModel` at the link seam). The turn's `llm` stamp is per turn. `SessionTeamChoices` holds the choice for the turn's length so ambient readers (the live run mode in bootstrap, the tool catalog gate, `FusionDelegateDeps.currentWorker`; `fusion.delegate` reads the director from the run mode) see it; a fusion worker borrows its parent's. A picked director (one usable, or the team's default of several; usable is `teamMemberReachable`, so a signed-out or missing CLI is not picked) is stamped and said once as `fusion_director_notice`, except that a team listing one director which is the orchestrator leg itself (`isOrchestratorLeg`: a team made from the seats, issue #71) leads unstamped and unsaid, as the leg did; when the director's link falls over and another link answers, the route's main leg names that link and a `fell-over` notice says so; a Codex CLI director gets one line, on the first turn it leads, that its own `model: "orchestrator"` tasks go to workers (the `cliToolsStayOn` refusal stays). The chat's reviewer (issue #71, `reviewer` option: a team reviewer, `"none"`, or `"team"`, which clears the stamp so the team picks again) is stamped the same way (a named one the folder refuses is refused with the provider refusal); `resolveSessionReviewer` reads it for the turn (`SessionTeamChoice.reviewer`, held whenever the team exists, even when no director leads, `FusionDelegateDeps.currentReviewer`, the plan context): a stamp the team no longer lists or the folder refuses is dropped and the team picks. `fusionTeamRoster` lists the team by role with `usable` / `reason` / `why` for a chat's folder and the runtime's reachability, for the frontends' seats (`GET /api/fusion/team`). No team: nothing changes.

## Fusion project

[composition/runtime-project.ts](composition/runtime-project.ts) (issue #39) is the person's side of `SessionState.project`. `runtime.projectState(sessionId)` returns the `ProjectGateView` a surface draws (types in `session/project-gate-view.ts`, built by `tools/fusion/project-gate-view.ts`); `runtime.projectDecision(sessionId, decision)` applies `applyProjectDecision` between turns only (`turn-running` while the session is busy), with hard caps, re-estimates and the cheaper/quality variants computed from the live team, prices, folder policy and limits (`liveProjectInputsFrom`; the daily limit holds the next milestone), persists the session and returns the project and view or a typed error. Every decision and every turn that moves the gate (`onProjectTurnEnd`) emits `project_gate` with the full view.

## Task-specific reading

Read docs/lifecycle.md before changing ownership, shutdown or steering; ../llm/docs/fallback.md before changing fallback wiring.

## Validation

`npx vitest run src/runtime`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).

Context compaction is owned by [context-compaction.ts](context-compaction.ts) and [its runner](context-compaction-runner.ts), which chooses between [the bounded model summary](context-compaction-model.ts) and [the extractive builder](compaction-extractive.ts), or uses [a rolling summary](compaction-rolling.ts) that [the background scheduler](compaction-background.ts) extends between turns. Both summaries share [the note for a request still handled after the cut](compaction-open-request.ts). With `agent.compaction.memoryFlush` on, [the memory flush](compaction-memory-flush.ts) first stores dated observations about the compacted records as a memory note (ATO-676); never for an incognito chat (ATO-586). Read the [compaction contract](docs/compaction.md) for control requests, checkpoints, budgets and cancellation.
