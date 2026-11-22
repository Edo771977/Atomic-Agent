export const MAX_PROJECT_UI_EXCEPTIONS = 200;

export interface ProjectUiException {
  rule: string;
  file?: string;
  reason: string;
}

export type ProjectUiExceptionDecision =
  | (ProjectUiException & { allow: true })
  | (Pick<ProjectUiException, "rule" | "file"> & { allow: false });

export function uiExceptionTarget(target: string): Pick<ProjectUiException, "rule" | "file"> | undefined {
  const [rule, rawFile, extra] = target.split(":");
  if (!rule || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(rule) || extra !== undefined) return;
  if (rawFile === undefined) return { rule };
  const file = rawFile.replace(/\\/g, "/");
  if (file.length > 256 || /[\p{Cc}\p{Cf}]/u.test(file) ||
      file.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) return;
  return { rule, file };
}

export function validUiExceptionReason(reason: string): boolean {
  return reason.trim().length > 0 && reason.length <= 500 && !/[\p{Cc}\p{Cf}]/u.test(reason);
}

export function readProjectUiExceptions(raw: unknown): ProjectUiException[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const exceptions: ProjectUiException[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return null;
    const { rule, file, reason } = item as Partial<ProjectUiException>;
    if (typeof rule !== "string" || (file !== undefined && typeof file !== "string") ||
        typeof reason !== "string" || !validUiExceptionReason(reason)) return null;
    const target = uiExceptionTarget(file === undefined ? rule : `${rule}:${file}`);
    if (target === undefined || target.rule !== rule || target.file !== file) return null;
    exceptions.push({ ...target, reason });
  }
  return exceptions;
}

export function matchesUiException(
  entry: Pick<ProjectUiException, "rule" | "file">,
  target: Pick<ProjectUiException, "rule" | "file">,
): boolean {
  return entry.rule === target.rule && entry.file === target.file;
}

export function applyUiExceptionDecision(
  current: readonly ProjectUiException[], decision?: ProjectUiExceptionDecision,
): readonly ProjectUiException[] {
  if (decision === undefined) return current;
  const { allow, ...entry } = decision;
  const kept = current.filter(item => !matchesUiException(item, entry));
  return allow && "reason" in entry ? [...kept, entry] : kept;
}
