import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as callers from "./auxiliary-caller-test-helpers.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

it("accounts for every production export ending in _SESSION_PREFIX, including explicit exclusions", () => {
  expect(callers.scanExportedSessionPrefixes).toBeTypeOf("function");
  const discovered = callers.scanExportedSessionPrefixes();
  expect(callers.sessionPrefixCoverageErrors(discovered)).toEqual([]);
  const excluded = Object.keys(callers.SESSION_PREFIX_EXCLUSIONS);
  expect(discovered.filter(entry => !excluded.includes(entry.name)).map(entry => entry.name).sort())
    .toEqual(callers.AUXILIARY_CALLERS.map(([name]) => name).sort());
  for (const name of excluded) expect(discovered.some(entry => entry.name === name)).toBe(true);
});

it.each(["new-prefix:", "btw:"])("detects a new caller even when its value %s reuses a registered prefix", prefix => {
  expect(callers.scanExportedSessionPrefixes).toBeTypeOf("function");
  root = mkdtempSync(join(tmpdir(), "prefix-discovery-"));
  mkdirSync(join(root, "runtime"));
  writeFileSync(join(root, "runtime", "new-caller.ts"), `export const NEW_CALLER_SESSION_PREFIX = ${JSON.stringify(prefix)};`);
  writeFileSync(join(root, "runtime", "fixture.test.ts"), 'export const FIXTURE_SESSION_PREFIX = "fixture:";');
  writeFileSync(join(root, "runtime", "not-exported.ts"), 'const PRIVATE_SESSION_PREFIX = "private:";');
  const discovered = callers.scanExportedSessionPrefixes(root);
  expect(discovered).toEqual([{ source: "runtime/new-caller.ts", name: "NEW_CALLER_SESSION_PREFIX", prefix }]);
  expect(callers.sessionPrefixCoverageErrors(discovered).join("\n")).toContain("NEW_CALLER_SESSION_PREFIX");
});
