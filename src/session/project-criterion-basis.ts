/** A check index is one-based within the run's contract. An output hash covers the retained output. */
export type ProjectCriterionBasis =
  | { kind: "check"; checks: Array<{ index: number; outputHash?: string }> }
  | { kind: "person" }
  | { kind: "vision"; model: string };

// Strongest to weakest. An explicit director acceptance would rank after vision,
// but there is no criterion-level acceptance by the director today.
const STRENGTH = ["check", "person", "vision"] as const satisfies readonly ProjectCriterionBasis["kind"][];

export function weakestCriterionBasis(
  first: ProjectCriterionBasis,
  second: ProjectCriterionBasis,
): ProjectCriterionBasis {
  if (first.kind === "check" && second.kind === "check") {
    return { kind: "check", checks: [...first.checks, ...second.checks] };
  }
  return STRENGTH.indexOf(first.kind) < STRENGTH.indexOf(second.kind) ? second : first;
}

/** Old or malformed provenance stays absent. Keep saved metadata bounded. */
export function readCriterionBasis(raw: unknown): ProjectCriterionBasis | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { kind, model, checks } = raw as Record<string, unknown>;
  if (kind === "person") return { kind };
  if (kind === "vision" && typeof model === "string") {
    const ref = model.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "").trim().slice(0, 200);
    return ref.length === 0 ? undefined : { kind, model: ref };
  }
  if (kind === "check" && Array.isArray(checks)) {
    const valid = checks.slice(0, 64).flatMap((check: unknown) => {
      if (typeof check !== "object" || check === null) return [];
      const { index, outputHash } = check as Record<string, unknown>;
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 1) return [];
      return [{ index, ...(typeof outputHash === "string" && /^[a-f0-9]{64}$/.test(outputHash) ? { outputHash } : {}) }];
    });
    if (valid.length > 0) return { kind, checks: valid };
  }
  return undefined;
}
