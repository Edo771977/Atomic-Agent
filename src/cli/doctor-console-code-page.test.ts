import { describe, expect, it } from "vitest";

import { checkConsoleCodePage } from "./doctor-console-code-page.js";
import { DOCTOR_CHECKS } from "./doctor-checks.js";

describe("doctor console-code-page check", () => {
  it("says nothing off Windows", () => {
    expect(checkConsoleCodePage({ platform: "linux", consoleCodePage: () => "437" })).toEqual([]);
  });

  it("is ok on a UTF-8 console and says how to read traces in Windows PowerShell 5.1", () => {
    const [finding] = checkConsoleCodePage({ platform: "win32", consoleCodePage: () => "65001" });
    expect(finding?.check).toBe("console-code-page");
    expect(finding?.status).toBe("ok");
    expect(finding?.message).toContain("65001");
    expect(finding?.message).toContain("Get-Content -Encoding UTF8");
  });

  it("warns on an OEM code page and says typed TUI input is not affected", () => {
    const [finding] = checkConsoleCodePage({ platform: "win32", consoleCodePage: () => "850" });
    expect(finding?.status).toBe("warn");
    expect(finding?.message).toContain("850");
    expect(finding?.message).toContain("chcp 65001");
    expect(finding?.message).toContain("typed input");
  });

  it("is ok without a console code page to read (a piped run)", () => {
    const [finding] = checkConsoleCodePage({ platform: "win32", consoleCodePage: () => undefined });
    expect(finding?.status).toBe("ok");
    expect(finding?.message).toContain("no console");
  });

  it("is registered with the doctor", () => {
    expect(DOCTOR_CHECKS).toContain(checkConsoleCodePage);
  });
});
