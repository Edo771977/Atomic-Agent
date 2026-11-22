import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { VerifyRunConfig } from "./run-verify.js";
import { buildVerifyRunTool } from "./verify-run.js";

const config: VerifyRunConfig = {
  browser: {
    enabled: false,
    channel: "chrome",
    headless: true,
    cdpUrl: null,
    connect: "agent",
    userChromeDataDir: null,
    executablePath: null,
    noSandbox: false,
    launchTimeoutMs: 1_000,
    blockedDomains: [],
    allowedDomains: [],
  },
};
const workingDir = fileURLToPath(new URL("../../../docs/testing/fixtures/spreadsheet/", import.meta.url));
const spec = {
  kind: "spreadsheet",
  requiredSheets: ["Sales"],
  requiredColumns: [{ sheet: "Sales", columns: ["Item", "Amount"] }],
  totals: [{ sheet: "Sales", range: "B2:B3", totalCell: "B4", tolerance: 0.01 }],
};

async function verify(path: string) {
  const tool = buildVerifyRunTool({ config, approvals: {} as ApprovalGate, approvalRequired: false });
  return tool.run({ ...spec, path }, {
    workingDir,
    sessionId: "spreadsheet-e2e",
    stepIndex: 0,
    signal: new AbortController().signal,
  });
}

describe("spreadsheet verification fixtures through verify.run", () => {
  it("passes the reference workbook", async () => {
    const result = await verify("sales.xlsx");
    expect(result.status, result.summary).toBe("ok");
    expect(result.details).toMatchObject({ ok: true, kind: "spreadsheet", artifactStatus: "pass" });
  });

  it.each([
    ["formula-error.xlsx", /Sales.*B3.*#REF!/],
    ["wrong-total.xlsx", /Sales.*B4.*26.*25/],
  ])("fails %s with the cell and reason", async (path, detail) => {
    const result = await verify(path);
    expect(result.status, result.summary).toBe("error");
    expect(result.details).toMatchObject({ ok: false, kind: "spreadsheet", artifactStatus: "fail" });
    expect(result.summary).toMatch(detail);
  });
});
