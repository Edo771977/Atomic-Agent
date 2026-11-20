import type { ResolvedRunMode } from "../../llm/run-mode/index.js";

/**
 * What the operator reads in the chat the first time a session switches
 * into Fusion.
 *
 * Fusion is the one route where the composer states more than one
 * model and where a control appears that was not there a moment ago,
 * and none of that explains itself: the meta bar has room for labels,
 * not for what a worker is. So the mode introduces itself once, on the
 * way in, naming the two legs it actually resolved rather than
 * describing them in the abstract.
 *
 * Deliberately not repeated when fusion is merely re-applied (picking a
 * different orchestrator, say) — see `RunModeOrchestrator.setMode`.
 */
/**
 * The mark that opens the intro: a tree, because that is the shape of
 * the thing — one model on top deciding, several underneath doing.
 *
 * The old mark drew two nodes side by side labelled `cloud` and
 * `local`, which stopped being true the day either seat could hold
 * either kind. Nothing here encodes where a model runs: `●` is the one
 * that plans, `○` are the ones that execute, and the count is an emblem
 * rather than a readout — a fan-out sizes itself per job.
 *
 * Built from box-drawing and geometric glyphs the TUI already relies on
 * elsewhere, so it renders on the same terminals the rest of the chrome
 * does; nothing here is double-width, so it cannot reflow.
 */
export const FUSION_MARK = [
  "        \u25cf  orchestrator",
  "        \u2502",
  "   \u250c\u2500\u2500\u2500\u2500\u253c\u2500\u2500\u2500\u2500\u2510",
  "   \u25cb    \u25cb    \u25cb  workers",
].join("\n");

export function describeFusionIntro(rm: ResolvedRunMode): string {
  const orchestrator =
    rm.orchestratorModel ?? rm.orchestratorProviderId ?? "your cloud provider";
  const worker = rm.workerModel ?? rm.workerProviderId ?? "the local model";
  return [
    FUSION_MARK,
    "",
    "Fusion splits the work in a small team: one model decides, others do, and a reviewer can check.",
    "",
    `Right now, ${orchestrator} plans. It reads enough to choose an approach, breaks the job into self-contained parts, writes the brief for each, then reads what comes back, judges it, and sends anything weak out again.`,
    `${worker} executes: each worker takes one part and reports. They cannot reach you or ask for approval, so anything needing a person comes back up.`,
    "",
    "A third seat, the reviewer, checks each worker's result before the orchestrator takes it. In the TUI you list reviewers under llm.runMode.fusion.team.reviewers in config.json; at a project's plan card, press e (edit rows) and use ←/→ to pick each task's reviewer, or no review. A Claude Code or Codex (ChatGPT) subscription can review, read-only, on your plan.",
    "",
    "Ask for something bigger and it becomes a project that stops for you three times: the brief, the plan (each task's worker, reviewer and estimated cost), and each finished milestone with its checks.",
    "",
    "In a folder restricted to local models, Fusion runs on the local worker alone and cloud reviewers are not offered.",
    "",
    "How many run at once is not a setting. The orchestrator sizes each fan-out to the job at hand, up to what this machine can serve.",
    "",
    "Either seat takes either kind, and the pairing is the interesting part. Cloud planning with local workers is the usual one: sharp judgement, cheap bulk. Invert it and a local model plans while cloud workers execute: your reasoning never leaves the machine and you rent only the lifting. Two cloud providers work as well, a careful model directing a fast one. This setup has one managed local engine, which can serve either role.",
    "",
    "Worth playing with: a result is only as good as the model that did the work, and only as sensible as the model that planned it. Move that line and the output changes character.",
    "",
    "ctrl+r opens separate inference engine and model controls for each seat. Use the swap control to trade the seats. /runmode status says what is resolved right now; /runmode cloud or /runmode local leaves fusion.",
  ].join("\n");
}
