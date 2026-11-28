import { existsSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the deferred crawl JavaScript classification module absent", () => {
  expect(existsSync(new URL("./crawl-js-page.ts", import.meta.url))).toBe(false);
});
