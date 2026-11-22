import type { ApprovalGate } from "../../approval/approval-gate.js";
import { maskSecrets, type KnownSecret } from "../../error-reporting/secret-detector.js";
import type { CommandReadCheck, ReadTargetCheck } from "../read-scope/confine-reads.js";
import type { ShellGuardPolicy } from "../os/shell-command-guard/index.js";
import { attachResearchNetworkApproval, authorizeVerifyBatch, uiVerificationUnavailable } from "../verify/verify-authorization.js";
import type { ContractCheck } from "./contract.js";
import { CONTRACT_CHECKS_HELD, ContractChecksHeldError, type ContractCheckRunner } from "./contract-checks.js";
import { withNegativeControls } from "./contract-check-negative.js";

export type ContractCheckHoldGate = Partial<Pick<ApprovalGate,
  "holdsForOutsideContent" | "outsideContentSources" | "request" | "ruleDecisionFor" | "hasDeclinedTarget" |
  "offerVerifyPageTurnGrant" | "verifyPageGrantedForTurn"
>>;
export interface ContractCheckHold {
  decide(signal: AbortSignal, batch?: readonly Record<string, unknown>[]): Promise<string | undefined>;
  runner: ContractCheckRunner | undefined;
  finalRunner: ContractCheckRunner | undefined;
}

/**
 * Every batch is a new complete verification plan. No decision is cached
 * here: children, retries, resumed checks, changed env/cwd and later taint
 * all reach the real gate. The one standing answer is the gate's own: a
 * `verify_page_local` yes for the approved plan's folder stands for the
 * turn (`turnGrantFolder`), never after outside content. Serialize questions, never park a worker-owned prompt, and
 * approve every check in a batch before invoking even its first executor.
 */
export function createContractCheckHold(options: {
  runner: ContractCheckRunner | undefined;
  approvals: ContractCheckHoldGate;
  approvalRequired: boolean;
  sessionId: string;
  workingDir: string;
  /** Trusted source of the default plan, before further execution copies. */
  sourceWorkingDir?: string;
  tool: string;
  checks: readonly ContractCheck[];
  signal: AbortSignal;
  shellPolicy?: ShellGuardPolicy;
  checkCommandReads?: CommandReadCheck;
  checkReadTargets?: ReadTargetCheck;
  knownSecrets?: readonly KnownSecret[];
  readRoots?: readonly string[];
  checkInputs?: readonly string[];
  /** The approved project plan's folder: a local page check approved there stands for the turn. */
  turnGrantFolder?: string;
  uiExceptions?: { stateDir: string; projectRef: { folder: string; id: string } };
}): ContractCheckHold {
  const isUi = (spec: Record<string, unknown>) => (spec.kind ?? spec.type) === "ui";

  let tail = Promise.resolve();
  const authorize = (batch: readonly Record<string, unknown>[], workingDir: string, signal: AbortSignal, checkInputs?: readonly string[], onlyUi = false) => {
    const combined = AbortSignal.any([options.signal, signal]);
    const result = tail.then(async () => {
      combined.throwIfAborted();
      if (options.approvalRequired && options.approvals.request === undefined && batch.some(spec => !isUi(spec))) throw new Error("verification approval gate is unavailable");
      return authorizeVerifyBatch(batch, {
        approvals: options.approvals as ApprovalGate, approvalRequired: options.approvalRequired, continueOnUiApprovalDenial: true,
        onlyUi,
        uiExceptionStateDir: options.uiExceptions?.stateDir,
        ...(options.shellPolicy === undefined ? {} : { shellPolicy: options.shellPolicy }),
        ...(options.checkCommandReads === undefined ? {} : { checkCommandReads: options.checkCommandReads }),
        ...(options.checkReadTargets === undefined ? {} : { checkReadTargets: options.checkReadTargets }),
        ...(options.knownSecrets === undefined ? {} : { knownSecrets: options.knownSecrets }),
        ...(options.turnGrantFolder === undefined ? {} : { turnGrantFolder: options.turnGrantFolder }),
      }, {
        sessionId: options.sessionId, workingDir, ruleWorkdir: options.workingDir,
        stepIndex: 0, signal: combined, projectRef: options.uiExceptions?.projectRef,
        ...(options.readRoots === undefined ? {} : { readRoots: [...options.readRoots] }),
        checkInputs: checkInputs ?? options.checkInputs ?? [],
      });
    });
    tail = result.then(() => undefined, () => undefined);
    return untilAborted(result, combined);
  };
  const note = (err: unknown, signal: AbortSignal): string => {
    const held = options.approvals.holdsForOutsideContent?.(options.sessionId, "shell") === true ? CONTRACT_CHECKS_HELD : "contract checks held before execution: not run";
    const why = signal.aborted || options.signal.aborted ? "the turn was cancelled" : err instanceof Error ? err.message : String(err);
    return maskSecrets(`${held} (${why})`, options.knownSecrets ?? []);
  };
  const decide = async (signal: AbortSignal, batch: readonly Record<string, unknown>[] = options.checks): Promise<string | undefined> => {
    // A declared check's negative control (issue #110) is authorized as the
    // command it will run; the runner below gets it as its own batch.
    try { await authorize(withNegativeControls(batch), options.sourceWorkingDir ?? options.workingDir, signal); return undefined; }
    catch (err) { return note(err, signal); }
  };
  const inner = options.runner;
  const wrap = (final: boolean): ContractCheckRunner | undefined => inner === undefined ? undefined : Object.assign(
    async (specs: Parameters<ContractCheckRunner>[0], ctx: Parameters<ContractCheckRunner>[1]) => {
      // The final preflight already covers ordinary checks. Authorize UI
      // against the frozen workspace so its exact executable reaches the runner.
      const { onHold, ...rest } = ctx;
      const attachNetwork = (spec: Record<string, unknown>) => attachResearchNetworkApproval(spec, {
        approvals: options.approvals as ApprovalGate,
        ...(options.knownSecrets === undefined ? {} : { knownSecrets: options.knownSecrets }),
      }, { workingDir: options.workingDir, sessionId: options.sessionId, signal: AbortSignal.any([options.signal, ctx.signal]) });
      if (final && !specs.some(isUi)) return inner(specs.map(attachNetwork), rest);
      let checked: readonly Record<string, unknown>[];
      onHold?.start();
      try { checked = await authorize(specs, ctx.workingDir, ctx.signal, ctx.inputIntegrity?.paths, final); }
      catch (err) { throw new ContractChecksHeldError(note(err, ctx.signal)); }
      finally { onHold?.end(); }
      const approved = final ? specs.map((spec, index) => isUi(spec) ? checked[index]! : attachNetwork(spec)) : checked;
      const unavailable = approved.map(uiVerificationUnavailable);
      if (unavailable.every(reason => reason === undefined)) return inner(approved, rest);
      const runnable = approved.filter((_, index) => unavailable[index] === undefined);
      const checkTasks = rest.checkTasks?.filter((_, index) => unavailable[index] === undefined);
      const results = runnable.length === 0 ? [] : (await inner(runnable, { ...rest, ...(checkTasks === undefined ? {} : { checkTasks }) })).results;
      let next = 0;
      return { ok: false, results: unavailable.map(reason => reason === undefined
        ? results[next++] ?? { ok: false, error: "the runner returned no result" }
        : { ok: false, artifactStatus: "uncheckable" as const, error: reason }) };
    },
    inner.supportsInputIntegrity === true ? { supportsInputIntegrity: true as const } : {},
  );
  return { decide, runner: wrap(false), finalRunner: wrap(true) };
}

/** Cancel a queued waiter promptly too; its queued body later observes abort. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", onAbort); resolve(value); }, error => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}
