import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("records the B2 status privacy and public panel exception in the fork guide", () => {
  const guide = readFileSync(new URL("../../docs/user/fork-differences.md", import.meta.url), "utf8");
  expect(guide).toContain("`GET /api/discord/channel`");
  expect(guide).toContain("no bot identity");
  expect(guide).toContain("no raw `lastError`");
  for (const path of ["/panel/manifest.webmanifest", "/panel/icon.svg", "/panel/icon-180.png"]) expect(guide).toContain(`\`${path}\``);
  expect(guide).toContain("Public read");
  expect(guide).toContain("data APIs still require authentication");
});
