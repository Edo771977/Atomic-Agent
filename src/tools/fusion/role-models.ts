import type { FusionRole } from "../../config/llm-run-mode-config.js";
import type { FusionRoleModels } from "../../llm/run-mode/index.js";
import type { TeamMember } from "../../llm/run-mode/fusion-team.js";
import type { DelegateTask } from "./delegate-args.js";

/**
 * Models by role and by node (ATO-943).
 *
 * The planner tags a task with a `role` or names a `model`; this decides
 * which provider each task actually runs on, before anything starts:
 *
 *   explicit `model` (must be on the allowed list) > the role's model >
 *   the worker leg, as before.
 *
 * The allowed list is the worker leg plus every configured role model,
 * matched by model name or provider id. A name outside it refuses the
 * call (`unknownModels`), with the list, so the planner fixes it in one
 * regeneration.
 *
 * `model: "orchestrator"` (`ORCHESTRATOR_TASK_MODEL`) is always on the
 * list in fusion: the task runs on the orchestrator leg's provider and
 * model, as an ordinary worker turn (worker brief, tool filter, approval
 * refusals, fan-out write scope, read scope, pinned provider). The
 * orchestrator's own turn still changes nothing itself; this is how it
 * hands a hard part to the stronger model without doing it in its own
 * turn. Counted against `maxOrchestratorTasksPerTurn`; priced toward
 * `turnBudgetUsd` only where the leg has a price (a subscription CLI
 * leg has none).
 *
 * One guard: a second LOCAL model. A llama-server provider other than
 * the ones the session's legs already hold needs its own server and its
 * own memory, which this process cannot measure; without
 * `mixLocalModels` such a task runs on the worker leg and its row says
 * so. With no local leg held yet, the first extra local provider is
 * allowed and any different one after it is guarded the same way.
 *
 * With a fusion team that lists `workers` (issue #37, {@link TeamTaskRouting})
 * the allowed list is those members instead, keyed by member (provider
 * id and model), so two models on one provider stay two legs. A task
 * naming one (`"<providerId>:<model>"`, the model or the provider) runs
 * on that member, pinned to its model; any other name refuses the call;
 * a task naming none runs on the default worker. A role runs on its
 * model only when that model is a team worker.
 */

/** Where one task runs. */
export interface TaskLeg {
  providerId: string;
  /** Display and pricing label. */
  model: string;
  /** Whether it is the session's worker leg (the old, only, path). */
  isWorkerLeg: boolean;
  /** The role whose model this is, when a role picked it. */
  role?: FusionRole;
  /** The task named `model: "orchestrator"` and runs on that leg. */
  orchestrator?: true;
  /** Why the task did not run where it asked to, for its row. */
  note?: string;
  /** The team member (`"<providerId>:<model>"`) this leg is, when it is not the worker leg. */
  member?: string;
  /** The model every turn on this leg asks its provider for (a per-turn model); absent, the entry's own. */
  pinModel?: string;
}

export interface WorkerLegRef {
  providerId: string;
  model: string;
  /** As on {@link TaskLeg}: the leg is this team member. */
  member?: string;
  /** As on {@link TaskLeg}: turns on the leg ask for this model. */
  pinModel?: string;
}

/**
 * What task routing reads of a fusion team (issue #37): the workers a
 * task may name (already filtered by the folder's policy and
 * reachability), the worker of a task that names none, and whether a
 * provider takes a per-turn model (a local server serves one model).
 */
export interface TeamTaskRouting {
  workers: readonly TeamMember[];
  /** Null: a task that names none runs on the worker leg, as before. */
  defaultWorker: TeamMember | null;
  pinsModel: (providerId: string) => boolean;
}

/** Which leg a task runs on: the member when it is one, else the provider. */
export function legKey(leg: { providerId: string; member?: string }): string {
  return leg.member ?? leg.providerId;
}

/** The team worker a task's `model` names: by member, then model, then provider. */
export function teamWorkerFor(
  name: string,
  workers: readonly TeamMember[],
): TeamMember | undefined {
  return (
    workers.find((m) => m.ref === name) ??
    workers.find((m) => m.model === name) ??
    workers.find((m) => m.providerId === name)
  );
}

/** Where a team member runs: the worker leg when it is that leg's provider and model (or a local one), else its own pinned leg. */
function memberLeg(
  member: TeamMember,
  workerLeg: WorkerLegRef,
  team: TeamTaskRouting,
): TaskLeg {
  const pins = team.pinsModel(member.providerId);
  if (member.providerId === workerLeg.providerId && (member.model === workerLeg.model || !pins)) {
    return {
      providerId: workerLeg.providerId,
      model: workerLeg.model,
      isWorkerLeg: true,
      ...(pins ? { pinModel: member.model } : {}),
    };
  }
  return {
    providerId: member.providerId,
    model: member.model,
    isWorkerLeg: false,
    member: member.ref,
    ...(pins ? { pinModel: member.model } : {}),
  };
}

/** The `model` a task names to run on the orchestrator leg. */
export const ORCHESTRATOR_TASK_MODEL = "orchestrator";

/** The orchestrator leg as a task target, or `undefined` when it cannot be one. */
function orchestratorTarget(
  workerLeg: WorkerLegRef,
  orchestratorLeg: WorkerLegRef | undefined,
  team: TeamTaskRouting | undefined,
): WorkerLegRef | undefined {
  // The resolver never makes the two legs one provider; were they, the
  // name would simply mean the worker leg. With a team the legs are
  // members: a director and a worker on one provider are two, also when
  // the team lists only directors (the orchestrator leg is a member).
  if (orchestratorLeg === undefined) return undefined;
  const byMember = team !== undefined || orchestratorLeg.member !== undefined;
  const same =
    orchestratorLeg.providerId === workerLeg.providerId &&
    (!byMember || orchestratorLeg.model === workerLeg.model);
  return same ? undefined : orchestratorLeg;
}

/** The orchestrator leg as a task's leg. */
function orchestratorTaskLeg(orchestrator: WorkerLegRef): TaskLeg {
  return {
    providerId: orchestrator.providerId,
    model: orchestrator.model,
    isWorkerLeg: false,
    orchestrator: true,
    ...(orchestrator.member === undefined ? {} : { member: orchestrator.member }),
    ...(orchestrator.pinModel === undefined ? {} : { pinModel: orchestrator.pinModel }),
  };
}

/** Every model a task may name, worker leg first, each once; with a team, its workers. */
export function allowedModels(
  workerLeg: WorkerLegRef,
  roles: FusionRoleModels | undefined,
  team?: TeamTaskRouting,
): { providerId: string; model: string }[] {
  if (team !== undefined) {
    return team.workers.map((m) => ({ providerId: m.providerId, model: m.model }));
  }
  const out = [{ providerId: workerLeg.providerId, model: workerLeg.model }];
  for (const entry of Object.values(roles?.byRole ?? {})) {
    if (entry === undefined) continue;
    if (out.some((o) => o.providerId === entry.providerId)) continue;
    out.push({
      providerId: entry.providerId,
      model: entry.model ?? entry.providerId,
    });
  }
  return out;
}

/** The tasks whose `model` is not on the allowed list, as one refusal. */
export function unknownModels(
  tasks: readonly DelegateTask[],
  workerLeg: WorkerLegRef,
  roles: FusionRoleModels | undefined,
  orchestratorLeg?: WorkerLegRef,
  team?: TeamTaskRouting,
): string | undefined {
  const orchestrator = orchestratorTarget(workerLeg, orchestratorLeg, team);
  if (team !== undefined) return unknownTeamModels(tasks, team, orchestrator !== undefined);
  const allowed = allowedModels(workerLeg, roles);
  const bad = tasks.filter(
    (t) =>
      t.model !== undefined &&
      !(t.model === ORCHESTRATOR_TASK_MODEL && orchestrator !== undefined) &&
      !allowed.some((a) => a.model === t.model || a.providerId === t.model),
  );
  if (bad.length === 0) return undefined;
  const names = [
    ...allowed.map((a) => a.model),
    ...(orchestrator === undefined ? [] : [ORCHESTRATOR_TASK_MODEL]),
  ]
    .map((name) => `\`${name}\``)
    .join(", ");
  return `validation: ${bad
    .map((t) => `task "${t.id}" names model "${t.model}"`)
    .join("; ")}, which is not available here. Allowed models: ${names}. Use a task \`role\` or one of these names, or leave \`model\` out.`;
}

function unknownTeamModels(
  tasks: readonly DelegateTask[],
  team: TeamTaskRouting,
  orchestrator: boolean,
): string | undefined {
  const bad = tasks.filter(
    (t) =>
      t.model !== undefined &&
      !(t.model === ORCHESTRATOR_TASK_MODEL && orchestrator) &&
      teamWorkerFor(t.model, team.workers) === undefined,
  );
  if (bad.length === 0) return undefined;
  const names = [
    ...team.workers.map((m) => m.ref),
    ...(orchestrator ? [ORCHESTRATOR_TASK_MODEL] : []),
  ];
  const list = names.length === 0 ? "none is available here" : `allowed: ${names.map((n) => `\`${n}\``).join(", ")}`;
  return `validation: ${bad
    .map((t) => `task "${t.id}" names model "${t.model}"`)
    .join("; ")}, which is not one of the team's workers (llm.runMode.fusion.team.workers; ${list}). Name one of these, or leave \`model\` out to use the default worker.`;
}

/**
 * Where each task runs, in task order. Assumes `unknownModels` passed.
 * Pure: the same tasks and run mode always give the same legs.
 */
export function resolveTaskLegs(
  tasks: readonly DelegateTask[],
  workerLeg: WorkerLegRef,
  roles: FusionRoleModels | undefined,
  orchestratorLeg?: WorkerLegRef,
  team?: TeamTaskRouting,
): Map<string, TaskLeg> {
  const orchestrator = orchestratorTarget(workerLeg, orchestratorLeg, team);
  if (team !== undefined) return resolveTeamTaskLegs(tasks, workerLeg, roles, orchestrator, team);
  const legs = new Map<string, TaskLeg>();
  const workerDefault = (note?: string): TaskLeg => ({
    providerId: workerLeg.providerId,
    model: workerLeg.model,
    isWorkerLeg: true,
    ...(note === undefined ? {} : { note }),
  });
  // Local providers this fan-out holds: the legs', then the first extra
  // one a task is allowed onto.
  const heldLocal = new Set(roles?.localLegProviderIds ?? []);
  for (const task of tasks) {
    const byRole = roles?.byRole ?? {};
    let picked:
      | { providerId: string; model: string; local: boolean; role?: FusionRole }
      | undefined;
    if (task.model === ORCHESTRATOR_TASK_MODEL && orchestrator !== undefined) {
      // The orchestrator leg is one the session already holds, so the
      // second-local-model guard has nothing to say about it.
      legs.set(task.id, orchestratorTaskLeg(orchestrator));
      continue;
    }
    if (task.model !== undefined) {
      if (
        task.model === workerLeg.model ||
        task.model === workerLeg.providerId
      ) {
        legs.set(task.id, workerDefault());
        continue;
      }
      // The task's own role first, so a model shared by two roles is
      // attributed to the role the planner meant.
      const ordered = Object.entries(byRole).sort(([a], [b]) =>
        a === task.role ? -1 : b === task.role ? 1 : 0,
      );
      for (const [role, entry] of ordered) {
        if (entry === undefined) continue;
        if (entry.model === task.model || entry.providerId === task.model) {
          picked = {
            providerId: entry.providerId,
            model: entry.model ?? entry.providerId,
            local: entry.local,
            ...(task.role === role ? { role: role as FusionRole } : {}),
          };
          break;
        }
      }
    } else if (task.role !== undefined) {
      const entry = byRole[task.role];
      if (entry === undefined) {
        // A role with no model of its own is the worker leg's work, said
        // only when roles are configured at all (flag absent: no notes).
        legs.set(
          task.id,
          workerDefault(
            roles === undefined
              ? undefined
              : `role ${task.role} has no model configured (llm.runMode.fusion.roles.${task.role}); ran on the workers' model ${workerLeg.model}`,
          ),
        );
        continue;
      }
      picked = {
        providerId: entry.providerId,
        model: entry.model ?? entry.providerId,
        local: entry.local,
        role: task.role,
      };
    }
    if (picked === undefined) {
      legs.set(task.id, workerDefault());
      continue;
    }
    if (picked.providerId === workerLeg.providerId) {
      legs.set(task.id, {
        ...workerDefault(),
        ...(picked.role === undefined ? {} : { role: picked.role }),
      });
      continue;
    }
    if (
      picked.local &&
      !heldLocal.has(picked.providerId) &&
      heldLocal.size > 0 &&
      roles?.mixLocalModels !== true
    ) {
      legs.set(
        task.id,
        workerDefault(
          `${picked.model} is a second local model and this machine is not marked to hold two (llm.runMode.fusion.mixLocalModels); ran on the workers' model ${workerLeg.model}`,
        ),
      );
      continue;
    }
    if (picked.local) heldLocal.add(picked.providerId);
    legs.set(task.id, {
      providerId: picked.providerId,
      model: picked.model,
      isWorkerLeg: false,
      ...(picked.role === undefined ? {} : { role: picked.role }),
    });
  }
  return legs;
}

/**
 * {@link resolveTaskLegs} with a team: a named member, a role whose model
 * is a team worker, else the default worker. A second local server is
 * guarded as for roles; a local member takes no model pin.
 */
function resolveTeamTaskLegs(
  tasks: readonly DelegateTask[],
  workerLeg: WorkerLegRef,
  roles: FusionRoleModels | undefined,
  orchestrator: WorkerLegRef | undefined,
  team: TeamTaskRouting,
): Map<string, TaskLeg> {
  const legs = new Map<string, TaskLeg>();
  const heldLocal = new Set(roles?.localLegProviderIds ?? []);
  if (!team.pinsModel(workerLeg.providerId)) heldLocal.add(workerLeg.providerId);
  const fallback = (note?: string): TaskLeg => {
    const leg: TaskLeg =
      team.defaultWorker === null
        ? { providerId: workerLeg.providerId, model: workerLeg.model, isWorkerLeg: true }
        : memberLeg(team.defaultWorker, workerLeg, team);
    return note === undefined ? leg : { ...leg, note };
  };
  for (const task of tasks) {
    if (task.model === ORCHESTRATOR_TASK_MODEL && orchestrator !== undefined) {
      legs.set(task.id, orchestratorTaskLeg(orchestrator));
      continue;
    }
    let picked: TeamMember | undefined;
    let role: FusionRole | undefined;
    let note: string | undefined;
    if (task.model !== undefined) {
      picked = teamWorkerFor(task.model, team.workers);
    } else if (task.role !== undefined) {
      const entry = roles?.byRole[task.role];
      if (entry !== undefined) {
        picked = team.workers.find(
          (m) => m.providerId === entry.providerId && (entry.model === null || m.model === entry.model),
        );
        if (picked === undefined) {
          note = `role ${task.role}'s model ${entry.model ?? entry.providerId} is not one of the team's workers (llm.runMode.fusion.team.workers); ran on the default worker`;
        } else {
          role = task.role;
        }
      }
    }
    if (picked === undefined) {
      legs.set(task.id, fallback(note));
      continue;
    }
    const leg = memberLeg(picked, workerLeg, team);
    const local = !team.pinsModel(picked.providerId);
    if (
      local &&
      !leg.isWorkerLeg &&
      !heldLocal.has(picked.providerId) &&
      heldLocal.size > 0 &&
      roles?.mixLocalModels !== true
    ) {
      legs.set(
        task.id,
        fallback(
          `${picked.model} is a second local model and this machine is not marked to hold two (llm.runMode.fusion.mixLocalModels); ran on the default worker`,
        ),
      );
      continue;
    }
    if (local) heldLocal.add(picked.providerId);
    legs.set(task.id, role === undefined ? leg : { ...leg, role });
  }
  return legs;
}
