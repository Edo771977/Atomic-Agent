import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AtomicAgentConfig } from "../../config/index.js";
import { defaultBrowserLauncher, type BrowserLauncher } from "./run-page-kind.js";

type BrowserFixture = { launch: BrowserLauncher } | { skipReason: string };

function unavailable(skipReason: string): BrowserFixture {
  if (process.env.ATAG_VERIFY_REQUIRE_BROWSER === "1") throw new Error(skipReason);
  return { skipReason };
}

/** Probe the file navigation the tests need independently of verify.run. */
export async function probeVerifyBrowser(config: Pick<AtomicAgentConfig, "browser">): Promise<BrowserFixture> {
  const executablePath = process.env.ATAG_VERIFY_BROWSER_EXECUTABLE;
  const launch = defaultBrowserLauncher(executablePath ? {
    browser: { ...config.browser, executablePath },
  } : config);
  let browser;
  try {
    browser = await launch();
  } catch (error) {
    const message = String(error);
    const reasons = message.replace(/^Error: no browser available: /, "").split("; ");
    const missing = /no Chromium-family browser found|browser executable not found|executable doesn't exist|does not exist|missing dependencies/i;
    if (reasons.length === 2 && reasons.every((reason) => missing.test(reason))) return unavailable(message);
    throw error;
  }
  const dir = await mkdtemp(join(tmpdir(), "atag-browser-probe-"));
  try {
    const fixture = join(dir, "probe.html");
    await writeFile(fixture, "<p>local browser fixture</p>");
    const page = await browser.newPage();
    try {
      await page.goto(pathToFileURL(fixture).href);
    } catch (error) {
      if (String(error).includes("net::ERR_BLOCKED_BY_ADMINISTRATOR")) {
        return unavailable("Chromium policy blocks local file navigation (net::ERR_BLOCKED_BY_ADMINISTRATOR)");
      }
      throw error;
    }
    return { launch };
  } finally {
    try {
      await browser.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
