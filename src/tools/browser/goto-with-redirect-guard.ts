import type { Page } from "playwright-core";
import type { BrowserRedirectGuard } from "./browser-backend.js";

interface PausedRequest {
  requestId: string;
  redirectedRequestId?: string;
  request: { url: string };
}

/** Playwright's route callback alone only sees the first URL of a redirect chain. */
export async function gotoWithRedirectGuard(
  page: Page,
  url: string,
  options: Parameters<Page["goto"]>[1],
  guard?: BrowserRedirectGuard,
  ignoreNavigationError = false,
): Promise<void> {
  if (!guard) {
    const navigation = page.goto(url, options);
    if (ignoreNavigationError) await navigation.catch(() => undefined);
    else await navigation;
    return;
  }
  const session = await page.context().newCDPSession(page);
  const controller = new AbortController();
  const signal = AbortSignal.any([guard.signal, controller.signal]);
  let refusal: unknown;
  const timeout = options?.timeout ?? 30_000;
  let timeLeft = timeout;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let decisions = 0;
  const stopTimer = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    timeLeft -= performance.now() - startedAt;
  };
  const startTimer = () => {
    if (timeout === 0 || signal.aborted) return;
    startedAt = performance.now();
    timer = setTimeout(() => controller.abort(new Error(`Browser navigation timed out after ${timeout} ms`)), Math.max(0, timeLeft));
  };
  let navigationAborted: (() => void) | undefined;
  const pending = new Set<string>();
  const fail = (requestId: string) => session.send("Fetch.failRequest", {
    requestId,
    errorReason: "BlockedByClient",
  }).catch(() => undefined);
  const onPaused = (event: PausedRequest): void => {
    pending.add(event.requestId);
    void (async () => {
      try {
        if (event.redirectedRequestId !== undefined) {
          if (decisions++ === 0) stopTimer();
          try {
            await guard.authorize(event.request.url, signal);
          } finally {
            if (--decisions === 0 && navigationAborted) startTimer();
          }
          signal.throwIfAborted();
        }
        await session.send("Fetch.continueRequest", { requestId: event.requestId });
      } catch (error) {
        refusal ??= error;
        await fail(event.requestId);
      } finally {
        pending.delete(event.requestId);
      }
    })();
  };
  session.on("Fetch.requestPaused", onPaused);
  try {
    signal.throwIfAborted();
    await session.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        navigationAborted = () => reject(signal.reason);
        signal.addEventListener("abort", navigationAborted, { once: true });
      });
      signal.throwIfAborted();
      startTimer();
      await Promise.race([page.goto(url, { ...options, timeout: 0 }), aborted]);
    } catch (error) {
      if (refusal !== undefined || !ignoreNavigationError) throw refusal ?? error;
    }
    if (refusal !== undefined) throw refusal;
  } finally {
    stopTimer();
    if (navigationAborted) {
      signal.removeEventListener("abort", navigationAborted);
      navigationAborted = undefined;
    }
    if (signal.aborted) await session.send("Page.stopLoading").catch(() => undefined);
    controller.abort();
    await Promise.all([...pending].map(fail));
    await session.send("Fetch.disable").catch(() => undefined);
    session.off("Fetch.requestPaused", onPaused);
    await session.detach().catch(() => undefined);
  }
}
