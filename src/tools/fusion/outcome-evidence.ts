import type { TaskOutcomeRecord } from "./outcome-log.js";

/** Declared checks only. Candidate executions have a separate, success-conditioned scope. */
export function taskCheckEvidence(row: TaskOutcomeRecord): "passed" | "failed" | "unverified" {
  // Even malformed/unknown candidate metadata must not regain legacy direct-task eligibility.
  if ("candidate" in row || row.v !== 1 || row.acceptanceScope !== "task-checks" ||
      !Number.isInteger(row.attempt) || row.attempt < 1 ||
      row.judgeRetried !== false || row.escalations !== 0 ||
      typeof row.selfCheckNotice !== "boolean" || row.syntaxDemoted !== false ||
      (row.merge !== null && row.merge !== "merged") ||
      !["off", "green", "red"].includes(row.judge)) return "unverified";
  if (row.acceptance === "checks-passed" && row.status === "ok" && row.failure === null &&
      (row.judge === "off" || row.judge === "green")) return "passed";
  if (row.acceptance === "checks-failed" && row.status === "failed" && row.failure === "checks") return "failed";
  return "unverified";
}

/**
 * The report's check column (issue #30): `taskCheckEvidence`, except a
 * row whose record says no task-attributed check was declared
 * (`taskChecks: 0`) is `no-checks` rather than `unverified`. An older
 * record without the count, and a candidate row, stay `unverified`.
 * Display only: measured routing reads `taskCheckEvidence`.
 */
export function taskCheckColumn(row: TaskOutcomeRecord): "passed" | "failed" | "unverified" | "no-checks" {
  const evidence = taskCheckEvidence(row);
  if (evidence !== "unverified") return evidence;
  return !("candidate" in row) && row.taskChecks === 0 ? "no-checks" : "unverified";
}
