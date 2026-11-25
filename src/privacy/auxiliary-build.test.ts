import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
it("excludes the auxiliary isolation test helper from production compilation", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const file = resolve(root, "tsconfig.json");
  const config = ts.parseConfigFileTextToJson(file, readFileSync(file, "utf8"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  expect(parsed.errors).toEqual([]);
  expect(parsed.fileNames.filter(name => /auxiliary-isolation-(?:fixture|test-helpers)\.ts$/.test(name))).toEqual([]);
});
