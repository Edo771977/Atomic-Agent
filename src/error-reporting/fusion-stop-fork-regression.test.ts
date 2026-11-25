import { expect, it, vi } from "vitest";
import { captureError } from "./error-reporter.js";
import type { SentryClient } from "./sentry-client.js";

it.each(["FusionBudgetStopError", "FusionWorkerStopError"])("drops a wrapped %s while keeping unrelated failures", name => {
  const capture = vi.fn();
  const client = { capture } as unknown as SentryClient;
  const reason = Object.assign(new Error("fixture stop"), { name });
  captureError(client, new Error("tool failed", { cause: reason }), { source: "llm_failure" });
  expect(capture).not.toHaveBeenCalled();
  captureError(client, new Error("real defect"), { source: "llm_failure" });
  expect(capture).toHaveBeenCalledOnce();
});
