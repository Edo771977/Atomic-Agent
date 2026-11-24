/** Log bounded identifiers only. Error messages, paths and stacks can carry private data. */
export function routeErrorDiagnostics(error: unknown) {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return {
    errorName: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error",
    code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null,
  };
}
