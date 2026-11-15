import { describe, expect, it } from "vitest";

import type { FusionRoleModels } from "../../llm/run-mode/index.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  allowedModels,
  legKey,
  ORCHESTRATOR_TASK_MODEL,
  resolveTaskLegs,
  type TeamTaskRouting,
  unknownModels,
} from "./role-models.js";

const worker = { providerId: "local-llama", model: "qwen-14b" };
const roles: FusionRoleModels = {
  byRole: {
    build: { providerId: "or-coder", model: "qwen-coder", local: false },
    review: { providerId: "or-sonnet", model: "sonnet", local: false },
    utility: { providerId: "small-llama", model: "qwen3-8b", local: true },
  },
  mixLocalModels: false,
  localLegProviderIds: ["local-llama"],
};

function task(id: string, over: Partial<DelegateTask> = {}): DelegateTask {
  return { id, title: id, instructions: "do it", ...over };
}

describe("models by role (ATO-943)", () => {
  it("allows the worker leg and every role model, each provider once", () => {
    expect(allowedModels(worker, roles)).toEqual([
      { providerId: "local-llama", model: "qwen-14b" },
      { providerId: "or-coder", model: "qwen-coder" },
      { providerId: "or-sonnet", model: "sonnet" },
      { providerId: "small-llama", model: "qwen3-8b" },
    ]);
    expect(allowedModels(worker, undefined)).toEqual([worker]);
  });

  it("rejects a model outside the list, by model name or provider id", () => {
    expect(
      unknownModels([task("a", { model: "sonnet" }), task("b", { model: "or-coder" })], worker, roles),
    ).toBeUndefined();
    const refusal = unknownModels([task("a", { model: "gpt-9" })], worker, roles);
    expect(refusal).toContain('task "a" names model "gpt-9"');
    expect(refusal).toContain("`qwen-14b`, `qwen-coder`, `sonnet`, `qwen3-8b`");
    // Without roles only the worker leg is allowed.
    expect(unknownModels([task("a", { model: "sonnet" })], worker, undefined)).toBeDefined();
    expect(unknownModels([task("a", { model: "qwen-14b" })], worker, undefined)).toBeUndefined();
  });

  it("resolves explicit model, then role, then the worker leg", () => {
    const legs = resolveTaskLegs(
      [
        task("m", { model: "sonnet", role: "build" }),
        task("r", { role: "build" }),
        task("d"),
        task("w", { model: "qwen-14b" }),
      ],
      worker,
      roles,
    );
    expect(legs.get("m")).toMatchObject({ providerId: "or-sonnet", isWorkerLeg: false });
    expect(legs.get("m")?.role).toBeUndefined();
    expect(legs.get("r")).toMatchObject({ providerId: "or-coder", model: "qwen-coder", role: "build" });
    expect(legs.get("d")).toEqual({ providerId: "local-llama", model: "qwen-14b", isWorkerLeg: true });
    expect(legs.get("w")).toMatchObject({ isWorkerLeg: true });
  });

  it("notes a role with no model of its own, only when roles are configured", () => {
    expect(resolveTaskLegs([task("e", { role: "explore" })], worker, roles).get("e")?.note).toContain(
      "role explore has no model configured",
    );
    expect(resolveTaskLegs([task("e", { role: "explore" })], worker, undefined).get("e")).toEqual({
      providerId: "local-llama",
      model: "qwen-14b",
      isWorkerLeg: true,
    });
  });

  it("guards a second local model unless the machine is marked to hold both", () => {
    const guarded = resolveTaskLegs([task("u", { role: "utility" })], worker, roles).get("u");
    expect(guarded).toMatchObject({ providerId: "local-llama", isWorkerLeg: true });
    expect(guarded?.note).toContain("mixLocalModels");
    const mixed = resolveTaskLegs(
      [task("u", { role: "utility" })],
      worker,
      { ...roles, mixLocalModels: true },
    ).get("u");
    expect(mixed).toMatchObject({ providerId: "small-llama", isWorkerLeg: false, role: "utility" });
  });

  it("lets one extra local model in when the session holds none, and guards a different second one", () => {
    const cloudWorker = { providerId: "or-worker", model: "flash" };
    const twoLocal: FusionRoleModels = {
      byRole: {
        utility: { providerId: "small-llama", model: "qwen3-8b", local: true },
        explore: { providerId: "other-llama", model: "gemma", local: true },
      },
      mixLocalModels: false,
      localLegProviderIds: [],
    };
    const legs = resolveTaskLegs(
      [task("u", { role: "utility" }), task("u2", { role: "utility" }), task("e", { role: "explore" })],
      cloudWorker,
      twoLocal,
    );
    expect(legs.get("u")?.providerId).toBe("small-llama");
    expect(legs.get("u2")?.providerId).toBe("small-llama");
    expect(legs.get("e")).toMatchObject({ providerId: "or-worker", isWorkerLeg: true });
    expect(legs.get("e")?.note).toContain("second local model");
  });

  it("treats a role pinned to the worker leg as the worker leg", () => {
    const sameLeg: FusionRoleModels = {
      ...roles,
      byRole: { utility: { providerId: "local-llama", model: "qwen-14b", local: true } },
    };
    expect(resolveTaskLegs([task("u", { role: "utility" })], worker, sameLeg).get("u")).toEqual({
      providerId: "local-llama",
      model: "qwen-14b",
      isWorkerLeg: true,
      role: "utility",
    });
  });
});

describe("model: \"orchestrator\"", () => {
  const orchestrator = { providerId: "cloud-big", model: "big-model" };

  it("is allowed whenever the orchestrator leg is known, roles or not", () => {
    const tasks = [task("h", { model: ORCHESTRATOR_TASK_MODEL })];
    expect(unknownModels(tasks, worker, undefined, orchestrator)).toBeUndefined();
    expect(unknownModels(tasks, worker, roles, orchestrator)).toBeUndefined();
    // No orchestrator leg to run it on: refused, and the list says so.
    const refusal = unknownModels(tasks, worker, undefined);
    expect(refusal).toContain('names model "orchestrator"');
    expect(unknownModels([task("x", { model: "gpt-9" })], worker, undefined, orchestrator)).toContain(
      "`qwen-14b`, `orchestrator`",
    );
  });

  it("resolves to the orchestrator leg's provider and model, off the worker leg", () => {
    const legs = resolveTaskLegs(
      [task("h", { model: ORCHESTRATOR_TASK_MODEL, role: "build" }), task("d")],
      worker,
      roles,
      orchestrator,
    );
    expect(legs.get("h")).toEqual({
      providerId: "cloud-big",
      model: "big-model",
      isWorkerLeg: false,
      orchestrator: true,
    });
    expect(legs.get("d")).toMatchObject({ providerId: "local-llama", isWorkerLeg: true });
  });

  it("is not subject to the second-local-model guard: the session already holds that leg", () => {
    const localOrchestrator = { providerId: "big-llama", model: "big-local" };
    const legs = resolveTaskLegs(
      [task("h", { model: ORCHESTRATOR_TASK_MODEL })],
      worker,
      { ...roles, localLegProviderIds: ["big-llama", "local-llama"] },
      localOrchestrator,
    );
    expect(legs.get("h")).toMatchObject({ providerId: "big-llama", isWorkerLeg: false });
    expect(legs.get("h")?.note).toBeUndefined();
  });
});

describe("routing by fusion team member (issue #37)", () => {
  const member = (ref: string) => {
    const at = ref.indexOf(":");
    return { providerId: ref.slice(0, at), model: ref.slice(at + 1), ref };
  };
  const cloudWorker = { providerId: "cli-b", model: "model-b" };
  const team: TeamTaskRouting = {
    workers: [member("cli-b:model-b"), member("cli-b:model-c"), member("api-d:model-d")],
    defaultWorker: member("cli-b:model-c"),
    pinsModel: (providerId) => providerId !== "local-llama",
  };

  it("offers the team's workers, keyed by member, not by provider", () => {
    expect(allowedModels(cloudWorker, roles, team)).toEqual([
      { providerId: "cli-b", model: "model-b" },
      { providerId: "cli-b", model: "model-c" },
      { providerId: "api-d", model: "model-d" },
    ]);
  });

  it("refuses a model or provider outside the team's workers, naming the members", () => {
    expect(
      unknownModels([task("a", { model: "model-c" }), task("b", { model: "api-d:model-d" })], cloudWorker, roles, undefined, team),
    ).toBeUndefined();
    // A role model that is not a team worker is not on the list.
    const refusal = unknownModels([task("a", { model: "qwen-coder" }), task("b", { model: "or-sonnet" })], cloudWorker, roles, undefined, team);
    expect(refusal).toContain('task "a" names model "qwen-coder"');
    expect(refusal).toContain('task "b" names model "or-sonnet"');
    expect(refusal).toContain("llm.runMode.fusion.team.workers");
    expect(refusal).toContain("`cli-b:model-b`, `cli-b:model-c`, `api-d:model-d`");
  });

  it("runs a named member on its own model, and a task naming none on the default worker", () => {
    const legs = resolveTaskLegs(
      [task("n", { model: "api-d:model-d" }), task("m", { model: "model-b" }), task("d")],
      cloudWorker,
      undefined,
      undefined,
      team,
    );
    expect(legs.get("n")).toEqual({
      providerId: "api-d", model: "model-d", isWorkerLeg: false, member: "api-d:model-d", pinModel: "model-d",
    });
    // The worker leg's own member is the worker leg, pinned to its model.
    expect(legs.get("m")).toEqual({ providerId: "cli-b", model: "model-b", isWorkerLeg: true, pinModel: "model-b" });
    // Same provider, another model: its own leg, not collapsed into the worker leg.
    expect(legs.get("d")).toEqual({
      providerId: "cli-b", model: "model-c", isWorkerLeg: false, member: "cli-b:model-c", pinModel: "model-c",
    });
    expect(legKey(legs.get("d")!)).not.toBe(legKey(legs.get("m")!));
  });

  it("does not pin a model on a local member, whose server serves one model", () => {
    const local: TeamTaskRouting = { ...team, workers: [member("local-llama:qwen-14b")], defaultWorker: member("local-llama:qwen-14b") };
    expect(resolveTaskLegs([task("d")], worker, undefined, undefined, local).get("d")).toEqual({
      providerId: "local-llama", model: "qwen-14b", isWorkerLeg: true,
    });
  });

  it("keeps the worker leg for a task naming none when the team has no default worker", () => {
    const none: TeamTaskRouting = { ...team, defaultWorker: null };
    expect(resolveTaskLegs([task("d")], cloudWorker, undefined, undefined, none).get("d")).toEqual({
      providerId: "cli-b", model: "model-b", isWorkerLeg: true,
    });
  });

  it("routes a role only to a team worker, and says why otherwise", () => {
    const teamRoles: FusionRoleModels = {
      byRole: {
        build: { providerId: "api-d", model: "model-d", local: false },
        review: { providerId: "or-sonnet", model: "sonnet", local: false },
      },
      mixLocalModels: false,
      localLegProviderIds: [],
    };
    const legs = resolveTaskLegs([task("b", { role: "build" }), task("r", { role: "review" })], cloudWorker, teamRoles, undefined, team);
    expect(legs.get("b")).toMatchObject({ providerId: "api-d", model: "model-d", role: "build", member: "api-d:model-d" });
    expect(legs.get("r")).toMatchObject({ providerId: "cli-b", model: "model-c", member: "cli-b:model-c" });
    expect(legs.get("r")?.note).toContain("not one of the team's workers");
  });

  it("keeps a director and a worker on one provider apart: the orchestrator target compares members", () => {
    const director = { providerId: "cli-b", model: "model-a", member: "cli-b:model-a", pinModel: "model-a" };
    expect(unknownModels([task("h", { model: ORCHESTRATOR_TASK_MODEL })], cloudWorker, undefined, director, team)).toBeUndefined();
    expect(resolveTaskLegs([task("h", { model: ORCHESTRATOR_TASK_MODEL })], cloudWorker, undefined, director, team).get("h")).toEqual({
      providerId: "cli-b", model: "model-a", isWorkerLeg: false, orchestrator: true, member: "cli-b:model-a", pinModel: "model-a",
    });
    // The same member as the worker leg: no separate target.
    const same = { providerId: "cli-b", model: "model-b" };
    expect(unknownModels([task("h", { model: ORCHESTRATOR_TASK_MODEL })], cloudWorker, undefined, same, team)).toContain('names model "orchestrator"');
  });
});
