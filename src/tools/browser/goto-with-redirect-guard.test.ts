import type { Page } from "playwright-core";
import { expect, it, vi } from "vitest";
import { gotoWithRedirectGuard } from "./goto-with-redirect-guard.js";

it("fails a paused document redirect before allowing Chrome to send it", async () => {
  const target = "https://other.example/?q=first%0Asecond";
  let onPaused: ((event: {
    requestId: string;
    redirectedRequestId: string;
    request: { url: string };
  }) => void) | undefined;
  let settleNavigation: ((error: Error) => void) | undefined;
  const send = vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "Fetch.failRequest" || method === "Fetch.continueRequest") {
      settleNavigation?.(new Error("navigation stopped"));
    }
  });
  const session = {
    on: vi.fn((_event, listener: typeof onPaused) => { onPaused = listener; }),
    off: vi.fn(),
    send,
    detach: vi.fn(async () => undefined),
  };
  const page = {
    context: () => ({ newCDPSession: async () => session }),
    goto: vi.fn(() => new Promise<void>((resolve, reject) => {
      settleNavigation = onPaused ? reject : undefined;
      if (!onPaused) resolve();
      onPaused?.({ requestId: "second", redirectedRequestId: "first", request: { url: target } });
    })),
  } as unknown as Page;
  const denied = new Error("data URL denied");
  const authorize = vi.fn(async () => { throw denied; });
  await expect(gotoWithRedirectGuard(page, "https://first.example/", undefined, {
    signal: new AbortController().signal,
    authorize,
  })).rejects.toBe(denied);
  expect(authorize).toHaveBeenCalledWith(target, expect.any(AbortSignal));
  expect(send).toHaveBeenCalledWith("Fetch.failRequest", { requestId: "second", errorReason: "BlockedByClient" });
  expect(send.mock.calls.map(([method]) => method)).not.toContain("Fetch.continueRequest");
  expect(session.detach).toHaveBeenCalledOnce();
});
