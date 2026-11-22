/// <reference path="../../../scripts/pdfkit.d.ts" />

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import { evaluateDocument, parseDocumentSpec } from "./document-check.js";
import { buildVerifyRunTool } from "./verify-run.js";

const fixtureDir = fileURLToPath(new URL("../../../docs/testing/fixtures/document/", import.meta.url));
const criteria = {
  requiredSections: [" summary  ", "NEXT  Steps"],
  wordRange: { min: 55, max: 85 },
  language: "en",
};
const check = (input: string, extension: string, overrides: Record<string, unknown>) =>
  evaluateDocument(Buffer.from(input), extension, parseDocumentSpec(overrides));

describe("document checks", () => {
  it.each([
    [".md", "# **Summary** #\n\nNext steps\n----------\n\nWe will return."],
    [".txt", "\uFEFF SUMMARY\r\n  Next    Steps  \r\nWe will return."],
  ])("matches standalone titles in %s", async (extension, text) => {
    await expect(check(text, extension, { ...criteria, language: undefined, wordRange: undefined }))
      .resolves.toMatchObject({ status: "pass" });
  });

  it("disregards prose mentions, Markdown comments, and fenced code as headings", async () => {
    await expect(check("Mention Summary.\n\n<!--\n# Summary\n-->\n\n```md\n# Summary\n```", ".md", {
      requiredSections: ["Summary"],
    })).resolves.toMatchObject({ status: "fail", detail: expect.stringContaining("Summary") });
  });

  it("counts Unicode words within an inclusive range", async () => {
    await expect(check("# Résumé\nL’ici, café — twenty-one.", ".md", { wordRange: { min: 4, max: 4 } }))
      .resolves.toMatchObject({ status: "pass", detail: expect.stringContaining("4 words") });
    await expect(check("one two three", ".txt", { wordRange: { min: 1, max: 2 } }))
      .resolves.toMatchObject({ status: "fail", detail: expect.stringContaining("3 words") });
  });

  it.each(["tOdO", "TBD", "Lorem\tipsum", "[INSERIRE]", "[insert]", "xxx", "{REVIEW ME}"])(
    "reports the %s placeholder",
    async (placeholder) => {
      await expect(check(`Notes: ${placeholder}.`, ".txt", { extraPlaceholders: ["{review me}"] }))
        .resolves.toMatchObject({ status: "fail", detail: expect.stringContaining("placeholder") });
    },
  );

  it("matches full markers and treats extra markers literally", async () => {
    await expect(check("todos XXXL TBD2 regex such as aXb", ".txt", { extraPlaceholders: ["a.b"] }))
      .resolves.toMatchObject({ status: "pass" });
  });

  it("marks uncertain language uncheckable and rejects a confidently different language", async () => {
    await expect(check("Hello world", ".txt", { language: "en" }))
      .resolves.toMatchObject({ status: "uncheckable", detail: expect.stringContaining("language") });
    await expect(check(
      "Abbiamo controllato le domande che sono arrivate con la posta durante la settimana. Il gruppo ha risposto alle persone che hanno chiesto informazioni per il progetto e ha pubblicato una nota sulla prossima riunione.",
      ".txt", { language: "en" },
    )).resolves.toMatchObject({ status: "fail", detail: expect.stringContaining("detected it") });
  });

  it.each([
    ["requiredSections", { requiredSections: [" "] }],
    ["wordRange", { wordRange: { min: 10, max: 2 } }],
    ["wordRange", { wordRange: { min: 0, max: 1.5 } }],
    ["language", { language: "unknown" }],
    ["extraPlaceholders", { extraPlaceholders: "TODO" }],
  ])("validates %s", (field, raw) => {
    expect(() => parseDocumentSpec(raw)).toThrow(field);
  });

  it("reads Word title styles and PDF text without an external service", async () => {
    const sourceDir = fileURLToPath(new URL("../os/test-fixtures/", import.meta.url));
    await expect(evaluateDocument(await readFile(join(sourceDir, "sample.docx")), ".docx", parseDocumentSpec({
      requiredSections: ["Document Title", "Introduction"],
    }))).resolves.toMatchObject({ status: "pass" });
    await expect(evaluateDocument(await readFile(join(sourceDir, "sample.pdf")), ".pdf", parseDocumentSpec({})))
      .resolves.toMatchObject({ status: "pass" });
  });

  it("requires a PDF text layer on every page", async () => {
    const pdf = new PDFDocument();
    const bytes = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);
    });
    pdf.text("This page contains testable text.");
    pdf.addPage();
    pdf.end();
    await expect(evaluateDocument(await bytes, ".pdf", parseDocumentSpec({})))
      .resolves.toMatchObject({ status: "uncheckable", detail: expect.stringContaining("unavailable text") });
  });

  it("marks the requested language uncheckable even with a known criterion failure", async () => {
    await expect(check("Hello TODO", ".txt", { language: "en" })).resolves.toMatchObject({
      status: "uncheckable",
      detail: expect.stringMatching(/language.*TODO/),
    });
  });

  it.each([".md", ".txt", ".docx", ".pdf"])("fails closed on invalid %s", async (extension) => {
    await expect(evaluateDocument(Buffer.from([0xff, 0x00]), extension, parseDocumentSpec({})))
      .resolves.toMatchObject({ status: "uncheckable" });
  });
});

describe("document delivery fixture through verify.run", () => {
  const tool = buildVerifyRunTool({
    approvals: {} as ApprovalGate,
    approvalRequired: false,
    config: { browser: {
      enabled: false, channel: "chrome", headless: true, cdpUrl: null,
      connect: "agent", userChromeDataDir: null, executablePath: null,
      noSandbox: false, launchTimeoutMs: 1_000, blockedDomains: [], allowedDomains: [],
    } },
  });

  it.each([
    ["reference.md", "ok", "words"],
    ["missing-section.md", "error", "missing section"],
    ["placeholder.md", "error", "[insert]"],
  ])("%s returns %s", async (path, status, detail) => {
    const outcome = await tool.run(
      { kind: "document", path: join("document", path), ...criteria },
      { workingDir: dirname(fixtureDir), sessionId: "document-e2e", stepIndex: 0, signal: new AbortController().signal },
    );
    expect(outcome.status).toBe(status);
    expect(outcome.summary).toContain(detail);
  });
});
