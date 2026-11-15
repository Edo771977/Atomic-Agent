# Local, Cloud and Fusion resolution

Status: current
Owner: src/llm/run-mode/

The resolver derives the effective mode from live provider configuration and validated pins. A stored mode label alone does not guarantee that its designated orchestrator is active. Switching providers re-resolves behavior; worker and orchestrator provider kind/id validation belongs to config.

Read [LLM instructions](../AGENTS.md), [resolver](resolve-run-mode.ts), [fusion setup planner](fusion-setup-plan.ts) (`setup fusion`), [resolver tests](resolve-run-mode.test.ts), [run-mode schema](../../config/llm-run-mode-config.ts), and [workers](../../tools/fusion/README.md).

[Fusion team](fusion-team.ts) (issue #37) holds the pure helpers behind `llm.runMode.fusion.team`: `parseTeamMember` / `teamMembers` (members are `providerId:model`, compared by the whole ref), `memberFamily` / `teamFamilyOf` (anthropic, openai, local, other, from the provider kind), `memberReachable` over `TeamReachabilityFacts` (filled from `detectFusionSetup` by `teamFactsFromSetup`, or by the TUI from its own status; only a member known to be broken is unreachable), `filterByPolicy` (folder provider constraints, directors included), and the picks `defaultDirector`, `defaultWorker` and `pickReviewer` (cross-family by default; null means the caller keeps `judgeProvider`). They read no config or state.

`resolveRunMode(resolved, { director, worker })` takes a session's director (issue #37): with the stored mode `fusion` and its provider configured, it is the orchestrator leg (`orchestratorModel` is its model, `director` is set) and fusion is effective without `activeTextProvider` naming it. Legs are then compared as members (provider and model), so a director and a worker on one CLI stay two legs; a preferred `worker` that is the director is ignored.
