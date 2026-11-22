import { describe, expect, it } from "vitest";

import { parseTeamMember, type TeamMember } from "../../llm/run-mode/fusion-team.js";
import { enrichPlanRows, type ProjectPlanContext } from "./project-tools.js";

const m = (ref: string): TeamMember => parseTeamMember(ref)!;
const qwen = m("local:qwen-3.6");
const codex = m("codex-cli:default");
const claude = m("claude-cli:claude-opus-5");
const api = m("anthropic:claude-opus-5-5");

const context = (reviewers: TeamMember[]): ProjectPlanContext => ({
  workers: [qwen],
  reviewers,
  defaultWorker: qwen,
  reviewerFor: () => reviewers[0] ?? null,
  reviewOn: true,
  records: [],
  pricing: () => undefined,
  tokensPerSecond: () => null,
  minSamples: 3,
  days: 30,
});

const plan = (reviewer: string | null) => ({
  milestones: [{ id: "m1", title: "M1", kind: "base" as const }],
  tasks: [{ id: "t1", title: "T1", milestone: "m1", reviewer }],
});

/**
 * A director names a member the way a person would: the bare provider
 * (`codex-cli`) for its default model. That is the same member as
 * `codex-cli:default` (member-identity, issue #98), not an unknown one.
 */
describe("plan rows name team members by identity, not spelling", () => {
  it("takes a bare provider as its default member", () => {
    const out = enrichPlanRows(plan("codex-cli") as never, context([claude, codex, api]));
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (out.ok) expect(out.rows[0]!.reviewer).toBe(codex.ref);
  });

  it("takes `provider:` and `provider:default` the same way", () => {
    for (const name of ["codex-cli:", "codex-cli:default"]) {
      const out = enrichPlanRows(plan(name) as never, context([claude, codex, api]));
      expect(out.ok, name).toBe(true);
    }
  });

  it("still refuses a bare provider that is ambiguous or absent", () => {
    const twoClaude = [m("claude-cli:claude-opus-5"), m("claude-cli:claude-sonnet-5")];
    expect(enrichPlanRows(plan("claude-cli") as never, context(twoClaude)).ok).toBe(false);
    expect(enrichPlanRows(plan("gemini") as never, context([codex])).ok).toBe(false);
  });
});
