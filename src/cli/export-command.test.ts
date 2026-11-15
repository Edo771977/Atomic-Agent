import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseExportArgs, writeExportFile } from "./export-command.js";

describe("atomic-agent export args (ATO-1054)", () => {
  it("defaults to Markdown on stdout with tool lines", () => {
    expect(parseExportArgs(["s-1"])).toEqual({ sessionId: "s-1", last: false, format: "markdown", out: null, tools: true, force: false });
  });

  it("takes --last, --format, --out and --no-tools", () => {
    expect(parseExportArgs(["--last", "--format", "docx", "--out", "a.docx", "--no-tools"])).toEqual({
      sessionId: "",
      last: true,
      format: "docx",
      out: "a.docx",
      tools: false,
      force: false,
    });
    expect(parseExportArgs(["s-1", "--out", "a.md", "--force"])).toMatchObject({ force: true });
  });

  it("refuses bad usage with a reason", () => {
    expect(parseExportArgs([])).toMatch(/session id or --last/);
    expect(parseExportArgs(["s-1", "--last"])).toMatch(/not both/);
    expect(parseExportArgs(["s-1", "s-2"])).toMatch(/one session id/);
    expect(parseExportArgs(["s-1", "--format", "pdf"])).toMatch(/unknown format: pdf/);
    expect(parseExportArgs(["s-1", "--out"])).toMatch(/--out needs a value/);
    expect(parseExportArgs(["s-1", "--bogus"])).toMatch(/unknown option/);
  });

  describe("writing --out", () => {
    let dir = "";
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

    it("does not overwrite an existing file without --force", () => {
      dir = mkdtempSync(join(tmpdir(), "export-out-"));
      const path = join(dir, "chat.md");
      writeFileSync(path, "keep me");
      expect(writeExportFile(path, "new", false)).toMatch(/already exists.*--force/);
      expect(readFileSync(path, "utf8")).toBe("keep me");
    });

    it("overwrites with --force and writes a new file either way", () => {
      dir = mkdtempSync(join(tmpdir(), "export-out-"));
      const path = join(dir, "chat.md");
      expect(writeExportFile(path, "first", false)).toBeNull();
      expect(readFileSync(path, "utf8")).toBe("first");
      writeFileSync(path, "old");
      expect(writeExportFile(path, Buffer.from("second"), true)).toBeNull();
      expect(readFileSync(path, "utf8")).toBe("second");
    });
  });
});
