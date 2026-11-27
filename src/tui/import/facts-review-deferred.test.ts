import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createInitialImportPanelState } from "./import-panel-state.js";

describe("C3c terminal facts review remains deferred", () => {
  it("has no facts runner that can reach the deferred save service", () => {
    expect(existsSync(fileURLToPath(new URL("import-facts-runner.ts", import.meta.url)))).toBe(false);
  });
  it("has no facts view, approval reducer or keys before unchecked review is established", () => {
    for (const owner of ["import-facts-view.tsx", "import-facts-state.ts", "import-facts-reducer.ts", "import-facts-keys.ts"]) {
      expect(existsSync(fileURLToPath(new URL(owner, import.meta.url)))).toBe(false);
    }
  });
  it("does not attach a facts review to the established import form", () => {
    expect(createInitialImportPanelState()).not.toHaveProperty("facts");
  });
});
