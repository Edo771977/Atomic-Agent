import { expect, it } from "vitest";
import { coreLoadOverrides } from "./core-sessions.js";

it("passes an explicitly capability-checked MTP switch to Core", () => {
  const overrides = coreLoadOverrides as (args: readonly string[], speculative: { mtp: boolean }) => Record<string, unknown>;
  expect(overrides([], { mtp: true })).toMatchObject({ mtp: true, dflash: false });
  expect(overrides([], { mtp: false })).toMatchObject({ mtp: false, dflash: false });
});
