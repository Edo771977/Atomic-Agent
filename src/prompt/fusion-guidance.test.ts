import { describe, expect, it } from "vitest";

import {
  buildFusionGuidance,
  PROJECT_FLOW_GUIDANCE,
  FUSION_DELEGATE_TOOL,
  FUSION_GUIDANCE,
  isFusionActive,
  localTaskSizing,
} from "./fusion-guidance.js";
import {
  NO_FUSION_MACHINE_FACTS,
  resolveFusionMachineFacts,
  type FusionMachineFacts,
} from "./fusion-machine-facts.js";
import type { AtomicAgentConfig } from "../config/config-schema.js";
import { COMPOSIO_SEARCH_TOOL } from "./composio-guidance.js";
import { buildStablePrefix, type ToolDescriptor } from "./stable-prefix.js";
import type { CapabilitiesSummary } from "./capabilities.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "./tool-descriptors.js";
import { evaluateChecks } from "../tools/verify/verify-checks.js";

function descriptor(name: string): ToolDescriptor {
  return { name, summary: `${name} summary`, argsSchema: "{}" };
}

const CAPS: CapabilitiesSummary = {
  platform: "linux",
} as unknown as CapabilitiesSummary;

const FACTS: FusionMachineFacts = {
  workerLeg: "local",
  workerSlots: 4,
  workerTokenBudget: 24_192,
  workerModel: "qwen3-4b",
  tokensPerSecond: null,
};

const LOCAL_CONFIG = (completionMaxTokens: number): AtomicAgentConfig =>
  ({
    localModels: {
      mode: "managed",
      completionMaxTokens,
      managed: { parallel: 2, contextSize: 0, modelId: "qwen3-4b" },
    },
    llm: { providers: [], runMode: { mode: "fusion", fusion: {} } },
  }) as unknown as AtomicAgentConfig;

function facts(over: Partial<FusionMachineFacts>): FusionMachineFacts {
  return { ...NO_FUSION_MACHINE_FACTS, ...over };
}

function prefixWith(
  descriptors: readonly ToolDescriptor[],
  fusion?: FusionMachineFacts,
): string {
  return buildStablePrefix({
    toolDescriptors: descriptors,
    capabilities: CAPS,
    skillCatalog: [],
    ...(fusion === undefined ? {} : { fusion }),
  });
}

describe("isFusionActive", () => {
  it("keys off the delegate tool actually being mounted", () => {
    expect(isFusionActive([descriptor(FUSION_DELEGATE_TOOL)])).toBe(true);
    expect(isFusionActive([descriptor("os.fs.read")])).toBe(false);
    expect(isFusionActive([])).toBe(false);
  });
});

describe("the ### fusion prefix section", () => {
  it("is absent when the delegate tool is not mounted", () => {
    // A local- or cloud-only install must pay nothing for fusion: not a
    // token, not a byte of the KV-cached prefix — including the machine
    // facts, which are passed unconditionally by `buildPrompt`.
    const prefix = prefixWith([descriptor("os.fs.read")], FACTS);
    expect(prefix).not.toContain("### fusion");
    expect(prefix).not.toContain("worker agents");
    expect(prefix).not.toContain("qwen3-4b");
    expect(prefix).not.toContain("request slot");
    expect(prefix).not.toContain("shared context");
  });

  it("appears once the delegate tool is mounted", () => {
    const prefix = prefixWith([
      descriptor("os.fs.read"),
      descriptor(FUSION_DELEGATE_TOOL),
    ]);
    expect(prefix).toContain("### fusion");
    expect(prefix).toContain(FUSION_GUIDANCE);
  });

  it("sits after integrations and before instructions", () => {
    const prefix = prefixWith([
      descriptor(COMPOSIO_SEARCH_TOOL),
      descriptor(FUSION_DELEGATE_TOOL),
    ]);
    expect(prefix.indexOf("### integrations")).toBeLessThan(
      prefix.indexOf("### fusion"),
    );
    expect(prefix.indexOf("### fusion")).toBeLessThan(
      prefix.indexOf("### instructions"),
    );
  });

  it("leaves everything above it byte-identical", () => {
    // Placement is load-bearing for the KV cache: persona, rules,
    // skills and the whole tools catalog must not move when fusion
    // turns on. (The catalog itself does gain the descriptor — compare
    // the head, which is what the cache key covers first.)
    const without = prefixWith([descriptor("os.fs.read")]);
    const with_ = prefixWith([descriptor("os.fs.read")]);
    expect(with_.slice(0, with_.indexOf("### capabilities"))).toBe(
      without.slice(0, without.indexOf("### capabilities")),
    );
  });

  it("tells the orchestrator to keep design and delegate bulk", () => {
    // The failure mode this guards is the inverted split: a model that
    // delegates the judgement and keeps the typing spends cloud tokens
    // on the bulk, which is the exact cost model fusion exists to undo.
    expect(FUSION_GUIDANCE).toContain("plan");
    expect(FUSION_GUIDANCE).toMatch(/Keep the design/i);
    expect(FUSION_GUIDANCE).toContain("`fusion.delegate`");
  });

  it("says a worker brief must stand alone", () => {
    expect(FUSION_GUIDANCE).toMatch(/stand alone|self-contained/i);
    expect(FUSION_GUIDANCE).toContain("see the operator's request, not this chat");
  });

  it("says the call is solo and that results must be verified", () => {
    expect(FUSION_GUIDANCE).toContain("Call `fusion.delegate` on its own.");
    expect(FUSION_GUIDANCE).toContain("needs_orchestrator");
    // ATO-945: a worker's question is answered by the orchestrator and the task re-sent.
    expect(FUSION_GUIDANCE).toContain("`needs_input`: answer it, re-send.");
    expect(FUSION_GUIDANCE).not.toContain("cannot ask");
  });

  it.each([false, true])("teaches command checks that can fail in the rendered prefix (compact=%s)", (compact) => {
    const toolDescriptors = DEFAULT_TOOL_DESCRIPTORS.filter(
      ({ name }) => name === "fusion.delegate" || name === "project.plan",
    );
    const prefix = buildStablePrefix({ toolDescriptors, capabilities: CAPS, skillCatalog: [], compact });
    const guidance = prefix.slice(prefix.indexOf("### fusion\n"), prefix.indexOf("### instructions"));
    expect(guidance).toMatch(/observe the actual result/i);
    expect(guidance).toMatch(/measure numbers from source/i);
    expect(guidance).toMatch(/print and assert a success-only marker/i);
    expect(guidance).toMatch(/absence.*known positive.*`negative`.*must fail/i);
    expect(guidance).toContain("Review checks before work");
    const checks = [...guidance.matchAll(/`(exit 0|stdout (?:not )?contains "[^"]+")`/g)].map((match) => match[1]!);
    expect(checks).toEqual(["exit 0", 'stdout contains "passed"', 'stdout not contains "Tests: 0 passed"']);
    const verify = (exitCode: number, stdout: string): boolean =>
      evaluateChecks(checks, { kind: "command", exitCode, stdout }).every(({ ok }) => ok);
    expect(verify(0, "Tests: 1 passed")).toBe(true);
    expect(verify(0, "Tests: 10 passed")).toBe(true);
    expect(verify(0, "Tests: 0 passed")).toBe(false);
    expect(verify(1, "Tests: 1 passed")).toBe(false);
  });

  it("points both authoring descriptors at the check guidance in their full and compact forms", () => {
    for (const name of ["fusion.delegate", "project.plan"]) {
      const descriptor = DEFAULT_TOOL_DESCRIPTORS.find((tool) => tool.name === name)!;
      expect(descriptor.summary).toContain("checks that can fail");
      expect(descriptor.compact?.summary).toContain("checks that can fail");
      expect(descriptor.compact?.summary.length).toBeLessThan(120);
    }
  });

  it("says a task that replaced a user's file is not done until it is restored or the replacement was wanted (F43)", () => {
    // The status table carries `replaced the user's file sales.csv
    // (2,401 → 9 lines)` on the row; without this line the orchestrator
    // read the fact and merged anyway. The restore is a worker's call,
    // because the orchestrator's own writes are refused.
    expect(FUSION_GUIDANCE).toContain(
      "A task that replaced a pre-existing file is not done until the file is restored (`os.fs.restore` in a worker) or the replacement was asked for.",
    );
  });

  it("stays short enough to live in every turn's prefix", () => {
    // Every byte here is paid on every step of every fusion turn. The
    // machine lines carry capacity as well as a count — slots, a
    // worker's share of the shared context, the shared GPU — which is
    // what the orchestrator needed and could not see when a four-worker
    // fan-out overflowed its server; ~100 tokens is what that costs.
    // F43's restore line was paid for by shortening the others — the
    // budget is the budget.
    expect(FUSION_GUIDANCE.length).toBeLessThan(1400);
    // A local leg also says its workers see only the request's head
    // (~65 more chars): without it the orchestrator left in the request
    // what a local worker never read.
    expect(buildFusionGuidance(FACTS).length).toBeLessThan(1975);
    expect(
      buildFusionGuidance({ ...FACTS, tokensPerSecond: 6.4 }).length,
    ).toBeLessThan(1975);
    // A local leg's task-sizing clause is the other line that grows: one
    // file or function and ~N new lines instead of "a big one".
    expect(
      buildFusionGuidance({ ...FACTS, tokensPerSecond: 6.4, workerMaxNewLines: 650 })
        .length,
    ).toBeLessThan(2075);
  });
});

describe("the project flow in the ### fusion block (issue #39)", () => {
  const withProject = [descriptor(FUSION_DELEGATE_TOOL), descriptor("project.brief"), descriptor("project.plan"), descriptor("project.milestone")];

  it("teaches brief, plan, milestones, each a gate the person approves between turns", () => {
    const prefix = prefixWith(withProject, FACTS);
    const block = prefix.slice(prefix.indexOf("### fusion"), prefix.indexOf("### instructions"));
    expect(block).toContain(PROJECT_FLOW_GUIDANCE);
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/`project\.brief`/);
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/reply and stop/);
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/`project\.plan`/);
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/`project\.milestone`/);
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/### fusion project/);
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/never delegate while a gate waits/i);
  });

  it("asks for every success criterion to be mapped to contract checks by id, of the four kinds (issue #40)", () => {
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/`criteria: \[ids\]`/);
    for (const kind of ["e2e", "page", "game", "visual"]) expect(PROJECT_FLOW_GUIDANCE).toContain(kind);
  });

  it("asks for decisions in the brief and each one cited by a plan task (issue #112)", () => {
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/`project\.brief`:.*decisions/);
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/`project\.plan`:.*each decision.*`decisions`/);
  });

  it("teaches planned checks, exact delegation and updating the plan for a change", () => {
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/plan.*checks/i);
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/negative/);
    expect(PROJECT_FLOW_GUIDANCE).toMatch(/update.*plan/i);
    const plan = DEFAULT_TOOL_DESCRIPTORS.find((d) => d.name === "project.plan")!;
    expect(plan.argsSchema).toContain("checks?");
    expect(plan.argsSchema).toContain("decisions?");
  });

  it("the project.brief descriptor states the fixed game API (issue #40)", () => {
    const brief = DEFAULT_TOOL_DESCRIPTORS.find((d) => d.name === "project.brief")!;
    expect(brief.summary).toContain("window.__game");
    expect(brief.summary).toMatch(/start\(\{ ?seed, mode: "auto" ?\}\)/);
    expect(brief.summary).toMatch(/step\(\)/);
    expect(brief.summary).toMatch(/state\(\) → \{ ?over, winner, moves, error\? ?\}/);
  });

  it("is static: the same bytes whatever the project's state, and absent without the project tools", () => {
    expect(prefixWith(withProject, FACTS)).toBe(prefixWith(withProject, FACTS));
    expect(prefixWith([descriptor(FUSION_DELEGATE_TOOL)], FACTS)).not.toContain(PROJECT_FLOW_GUIDANCE);
    expect(buildFusionGuidance(FACTS, { project: true })).toContain(PROJECT_FLOW_GUIDANCE);
    expect(buildFusionGuidance(FACTS)).toBe(buildFusionGuidance(FACTS, { project: false }));
    expect(PROJECT_FLOW_GUIDANCE.length).toBeLessThan(700);
  });
});

describe("the machine facts in the ### fusion block", () => {
  it("states the measured single-stream speed of a local server when known", () => {
    // The number that turns "N times slower" into minutes per file for
    // the model choosing a width. Absent, nothing about speed is said.
    const withSpeed = buildFusionGuidance({ ...FACTS, tokensPerSecond: 6.4 });
    expect(withSpeed).toContain("~6.4 tok/s single stream");
    expect(buildFusionGuidance(FACTS)).not.toContain("tok/s");
    // A cloud leg never carries one, whatever the facts say.
    expect(
      buildFusionGuidance(
        facts({ workerLeg: "cloud", workerModel: "gpt-x", tokensPerSecond: 40 }),
      ),
    ).not.toContain("tok/s");
  });

  it("names the slot count, the local model and the resulting width", () => {
    // The orchestrator picks `maxWorkers` itself now. Choosing over
    // hardware it cannot see is guessing, so these are the facts that
    // actually decide the number.
    const prefix = prefixWith([descriptor(FUSION_DELEGATE_TOOL)], FACTS);
    expect(prefix).toContain("4 request slots");
    expect(prefix).toContain("`qwen3-4b`");
    expect(prefix).toContain("up to 4 run at once");
    expect(prefix).toContain("`maxWorkers` at most 4");
  });

  it("states a local worker's share of the context and the shared GPU", () => {
    const block = buildFusionGuidance(FACTS);
    expect(block).toContain("~24K tokens");
    expect(block).toContain("one shared context");
    expect(block).toMatch(/overflow it together all fail/);
    expect(block).toContain("share one GPU");
    expect(block).toMatch(/N times slower/);
    expect(block).toContain("timeouts");
    expect(block).toContain("keep briefs short");
  });

  it("says nothing about a fact it does not have", () => {
    // An external llama-server's `--parallel` is nobody's business but
    // the operator's; a guessed slot count is worse than none, because
    // it is a number the model will plan against.
    const noSlots = buildFusionGuidance(
      facts({ workerLeg: "local", workerTokenBudget: 24_192, workerModel: "qwen3-4b" }),
    );
    expect(noSlots).toContain("`qwen3-4b`");
    expect(noSlots).not.toContain("request slot");
    expect(noSlots).not.toContain("at most");
    expect(noSlots).toContain("the fan-out narrow");
    expect(noSlots).toContain("share one GPU");
    // No budget known: no budget sentence.
    expect(
      buildFusionGuidance(facts({ workerLeg: "local", workerSlots: 2 })),
    ).not.toContain("tokens of");
    // Nothing known at all: the behavioural lines and not a word more.
    expect(buildFusionGuidance(NO_FUSION_MACHINE_FACTS)).toBe(FUSION_GUIDANCE);
    expect(buildFusionGuidance()).toBe(FUSION_GUIDANCE);
  });

  it("singularises the one-slot case", () => {
    expect(
      buildFusionGuidance(facts({ workerLeg: "local", workerSlots: 1 })),
    ).toContain("1 request slot,");
  });

  it("tells a cloud leg it has no slot limit but pays per step", () => {
    const block = buildFusionGuidance(
      facts({ workerLeg: "cloud", workerModel: "gpt-x" }),
    );
    expect(block).toContain("`gpt-x` on a cloud provider");
    expect(block).toContain("no slot limit");
    expect(block).toContain("every worker step is billed");
    expect(block).not.toContain("request slot");
    expect(block).not.toContain("GPU");
  });

  it("is byte-identical across two builds with the same machine state", () => {
    // These bytes sit in the KV-cache-hot stable prefix: a timestamp, a
    // per-turn counter or a live pool size that resizes after the first
    // `/props` would drop the cache on every single step.
    const first = prefixWith([descriptor(FUSION_DELEGATE_TOOL)], { ...FACTS });
    const second = prefixWith([descriptor(FUSION_DELEGATE_TOOL)], { ...FACTS });
    // Stability is only interesting if the facts are in there at all —
    // otherwise this passes on any build that renders nothing.
    expect(first).toContain("4 request slots");
    expect(second).toBe(first);
  });

  it("pushes the orchestrator to delegate, honestly", () => {
    // "It should always try to involve them more often" — but never at
    // the price of sending work that cannot succeed without the
    // conversation the worker will not have.
    expect(FUSION_GUIDANCE).toContain(
      "every part that changes something is a worker's",
    );
    // Never "do it yourself": the orchestrator's mutations are refused.
    expect(FUSION_GUIDANCE).not.toMatch(/yourself/);
    expect(FUSION_GUIDANCE).toContain("independent parts");
    // And to check a fan-out before accepting it, but only what the
    // delegate's own contract checks and syntax pass left uncovered:
    // a re-run of `verify.syntax` is a strong step for nothing.
    expect(FUSION_GUIDANCE).toContain("Checks and syntax run for you");
    expect(FUSION_GUIDANCE).not.toContain("`verify.syntax` on the declared files");
    expect(FUSION_GUIDANCE).toContain("`verify.run` for uncovered criteria");
    expect(FUSION_GUIDANCE).toContain("context-dependent judgement");
    // And the width is stated as the model's own call.
    expect(FUSION_GUIDANCE).toMatch(/You choose `maxWorkers`/);
  });
});

describe("task sizing per worker leg", () => {
  it("cuts local tasks to one file or function and ~N new lines", () => {
    // A small local model with a small context: "a big one per worker"
    // is what it runs out of cap, context or steps on.
    const block = buildFusionGuidance({ ...FACTS, workerMaxNewLines: 300 });
    expect(block).toContain(
      "list the independent parts, one file or one function per task, at most ~300 new lines (fewer on a slow machine); edit large files, never rewrite them.",
    );
    expect(block).not.toContain("a big one per worker");
    expect(localTaskSizing(650)).toContain("at most ~650 new lines");
  });

  it("tells the orchestrator a local worker sees only the head of the request", () => {
    // A local brief quotes the first 6,000 chars (`worker-prompt.ts`):
    // what the task needs past them has to ride in `instructions`.
    const note =
      "workers see only the first ~6,000 chars of the request, not this chat; put what a task needs past that in `instructions`.";
    expect(buildFusionGuidance({ ...FACTS, workerMaxNewLines: 300 })).toContain(note);
    expect(buildFusionGuidance(FACTS)).toContain(note);
    // A cloud leg and an unknown one keep the line byte for byte.
    const cloud = buildFusionGuidance(facts({ workerLeg: "cloud", workerModel: "gpt-x" }));
    expect(cloud).not.toContain("6,000");
    expect(cloud).toContain(
      "workers see the operator's request, not this chat.",
    );
    expect(FUSION_GUIDANCE).not.toContain("6,000");
  });

  it("keeps the big-part line for a cloud leg and an unknown one", () => {
    expect(FUSION_GUIDANCE).toContain("a big one per worker, small ones shared.");
    const cloud = buildFusionGuidance(
      facts({ workerLeg: "cloud", workerModel: "gpt-x" }),
    );
    expect(cloud).toContain("a big one per worker");
    expect(cloud).not.toContain("new lines");
    // A local leg with no cap known keeps the default line.
    expect(buildFusionGuidance(FACTS)).toContain("a big one per worker");
  });

  it("derives N from the configured cap, the same bytes every step", () => {
    // The facts come from config only, so two builds in one session (two
    // steps) render the same prefix; a different cap is a config write.
    const small = resolveFusionMachineFacts(LOCAL_CONFIG(4_096));
    const big = resolveFusionMachineFacts(LOCAL_CONFIG(16_384));
    expect(buildFusionGuidance(small)).toContain("at most ~150 new lines");
    expect(buildFusionGuidance(big)).toContain("at most ~650 new lines");
    const descriptors = [descriptor(FUSION_DELEGATE_TOOL)];
    const first = prefixWith(descriptors, resolveFusionMachineFacts(LOCAL_CONFIG(8_192)));
    const second = prefixWith(descriptors, resolveFusionMachineFacts(LOCAL_CONFIG(8_192)));
    expect(first).toContain("at most ~300 new lines");
    expect(second).toBe(first);
  });
});


describe("the orchestrator as a task target", () => {
  it("sends hard parts and twice-failed ones to model \"orchestrator\", the bulk to workers", () => {
    for (const block of [FUSION_GUIDANCE, buildFusionGuidance(FACTS)]) {
      expect(block).toContain(
        'Hard parts, or one that failed twice, go to `model: "orchestrator"` (a worker turn on your model); keep the bulk on workers.',
      );
    }
  });
});

describe("a local worker's limits in the ### fusion block (ATO-1363)", () => {
  const LIMITS: FusionMachineFacts = {
    ...FACTS,
    workerMaxSteps: 60,
    workerTimeoutMs: 2_700_000,
  };

  it("states the step budget and the time limit, and the late guards", () => {
    const block = buildFusionGuidance(LIMITS);
    expect(block).toContain("Each local worker gets 60 steps and 45 min");
    expect(block).toContain("`maxSteps` / `timeoutMs`");
    expect(block).toContain("no write by half its steps is handed back");
    expect(block).toContain("split big files first");
    // No measured speed: nothing to check an estimate against, so no ask.
    expect(block).not.toContain("outputTokens");
  });

  it("asks for an output estimate once the speed is measured", () => {
    const block = buildFusionGuidance({ ...LIMITS, tokensPerSecond: 6.4 });
    expect(block).toContain("Set `outputTokens` (or `outputLines`)");
    expect(block).toContain("is flagged on its row");
    // The estimate line reports fit without refusing the task.
    const estimateLine = block.split("\n").find((line) => line.includes("outputTokens"));
    expect(estimateLine).not.toContain("refused");
  });

  it("renders as before when the limits are absent", () => {
    expect(buildFusionGuidance(FACTS)).not.toContain("Each local worker gets");
    expect(buildFusionGuidance(NO_FUSION_MACHINE_FACTS)).toBe(FUSION_GUIDANCE);
  });

  it("stays inside the prefix budget with every fact known", () => {
    expect(
      buildFusionGuidance({ ...LIMITS, tokensPerSecond: 6.4 }).length,
    ).toBeLessThan(2400);
  });
});
