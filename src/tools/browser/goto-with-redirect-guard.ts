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
          await guard.authorize(event.request.url, signal);
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
      await page.goto(url, options);
    } catch (error) {
      if (refusal !== undefined || !ignoreNavigationError) throw refusal ?? error;
    }
    if (refusal !== undefined) throw refusal;
  } finally {
    controller.abort();
    await Promise.all([...pending].map(fail));
    await session.send("Fetch.disable").catch(() => undefined);
    session.off("Fetch.requestPaused", onPaused);
    await session.detach().catch(() => undefined);
  }
}
