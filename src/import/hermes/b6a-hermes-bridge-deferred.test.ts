import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { IMPORT_OPTIONS, resolveSelectedOptions } from "./import-options.js";

it("keeps Hermes Python execution unavailable through import options", () => {
  expect(IMPORT_OPTIONS.map(option => option.id)).not.toContain("plugins");
  expect(resolveSelectedOptions({ preset: "full" })).not.toContain("plugins");
  expect(() => resolveSelectedOptions({ include: ["plugins"] })).toThrow();
});
it("does not turn a caller-supplied trust string into an import domain", () => {
  const input = { trustedPlugins: ["safe"] };
  expect(resolveSelectedOptions(input as never)).not.toContain("plugins");
});
it("keeps the Hermes bridge module and executable shim absent", () => {
  for (const path of ["./hermes-plugins.ts", "../../../assets/hermes-plugin-bridge/hermes_mcp_shim.py"]) {
    expect(existsSync(new URL(path, import.meta.url)), path).toBe(false);
  }
});
it("does not publish or bundle a Hermes execution shim", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { files: string[] };
  expect(manifest.files.some(path => path.includes("hermes-plugin-bridge"))).toBe(false);
  expect(readFileSync(new URL("../../../scripts/package-bundle.ts", import.meta.url), "utf8")).not.toContain("hermes-plugin-bridge");
});
