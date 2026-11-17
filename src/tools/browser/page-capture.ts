/**
 * Pixels of a Playwright page as a capped JPEG (ATO-515), shared by
 * `browser.screenshot` (the backend) and the `verify.run` page runner's
 * `screenshot` (issue #40): page metrics read in the page, secret fields
 * drawn as dots while the pixels are taken, and one CDP capture of a
 * planned clip (`screenshot-geometry.ts`).
 */
import type { Page } from "playwright-core";

import { SECRET_AUTOCOMPLETE_TOKENS } from "./redact-secret-fields.js";
import { BROWSER_SHOT_MAX_BYTES, planShot, SHOT_ATTEMPTS, type ShotPlan } from "./screenshot-geometry.js";

export interface ViewportMetrics {
  devicePixelRatio: number;
  pageX: number;
  pageY: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}

/** Runs in the page: scroll offset, viewport and document size in CSS pixels. */
export function readViewportMetricsInPage(): ViewportMetrics {
  const w = globalThis as unknown as {
    devicePixelRatio: number;
    scrollX: number;
    scrollY: number;
    innerWidth: number;
    innerHeight: number;
    visualViewport?: { pageLeft: number; pageTop: number; width: number; height: number } | null;
    document: { documentElement: { scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number } };
  };
  const vv = w.visualViewport;
  const root = w.document.documentElement;
  return {
    devicePixelRatio: w.devicePixelRatio || 1,
    pageX: vv ? vv.pageLeft : w.scrollX,
    pageY: vv ? vv.pageTop : w.scrollY,
    viewportWidth: vv ? vv.width : root.clientWidth || w.innerWidth,
    viewportHeight: vv ? vv.height : root.clientHeight || w.innerHeight,
    scrollWidth: Math.max(root.scrollWidth, root.clientWidth),
    scrollHeight: Math.max(root.scrollHeight, root.clientHeight),
  };
}

const SECRET_MASK_STYLE_ID = "__atomic_agent_secret_mask";
/** The same secret fields the snapshot masks (`redact-secret-fields.ts`). */
const SECRET_MASK_CSS =
  SECRET_AUTOCOMPLETE_TOKENS.map((token) => `input[autocomplete~="${token}"]`).join(",") +
  "{-webkit-text-security:disc!important}";

/** Runs in each frame: add or remove the style that draws secret fields as dots. */
function toggleSecretMaskInPage(arg: { on: boolean; id: string; css: string }): void {
  const doc = (globalThis as unknown as {
    document: {
      getElementById: (id: string) => { remove: () => void } | null;
      createElement: (tag: string) => { id: string; textContent: string };
      documentElement: { appendChild: (node: unknown) => void };
    };
  }).document;
  doc.getElementById(arg.id)?.remove();
  if (!arg.on) return;
  const style = doc.createElement("style");
  style.id = arg.id;
  style.textContent = arg.css;
  doc.documentElement.appendChild(style);
}

export async function setSecretFieldMask(page: Page, on: boolean): Promise<void> {
  await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(toggleSecretMaskInPage, { on, id: SECRET_MASK_STYLE_ID, css: SECRET_MASK_CSS })
        .catch(() => undefined),
    ),
  );
}

/** One CDP JPEG capture of `plan`, secret fields masked meanwhile. */
export async function capturePlannedJpeg(page: Page, plan: ShotPlan, quality: number, fullPage: boolean): Promise<Buffer> {
  await setSecretFieldMask(page, true);
  const session = await page.context().newCDPSession(page);
  try {
    const shot = (await session.send("Page.captureScreenshot", {
      format: "jpeg",
      quality,
      clip: { ...plan.clip, scale: plan.scale },
      captureBeyondViewport: fullPage,
    })) as { data: string };
    return Buffer.from(shot.data, "base64");
  } finally {
    await session.detach().catch(() => undefined);
    await setSecretFieldMask(page, false);
  }
}

export interface PageJpeg {
  readonly buffer: Buffer;
  readonly width: number;
  readonly height: number;
  /** A full-page shot was cut at the height cap. */
  readonly clipped: boolean;
}

/**
 * The viewport (or, with `fullPage`, the page from the top) under the
 * `browser.screenshot` caps: long side at most 1280 px, at most 900 KB,
 * retaken smaller and at lower quality until it fits. Throws when the
 * page has no visible area or no attempt fits.
 */
export async function capturePageJpeg(page: Page, options: { fullPage?: boolean } = {}): Promise<PageJpeg> {
  const fullPage = options.fullPage === true;
  const metrics = await page.evaluate(readViewportMetricsInPage);
  const rect = fullPage
    ? { x: 0, y: 0, width: metrics.scrollWidth, height: metrics.scrollHeight }
    : { x: metrics.pageX, y: metrics.pageY, width: metrics.viewportWidth, height: metrics.viewportHeight };
  let last = 0;
  for (const attempt of SHOT_ATTEMPTS) {
    const plan = planShot(rect, metrics.devicePixelRatio, attempt.maxSide, fullPage);
    if (plan === null) throw new Error("the page has no visible area");
    const buffer = await capturePlannedJpeg(page, plan, attempt.quality, fullPage);
    if (buffer.length <= BROWSER_SHOT_MAX_BYTES) return { buffer, width: plan.width, height: plan.height, clipped: plan.clipped };
    last = buffer.length;
  }
  throw new Error(`the screenshot is still ${last} bytes at the smallest size (limit ${BROWSER_SHOT_MAX_BYTES})`);
}
