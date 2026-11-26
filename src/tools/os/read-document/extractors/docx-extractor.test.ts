import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import { docxExtractor } from "./docx-extractor.js";
import { createDocx } from "../../office/docx-package.js";

const FIXTURE_PATH = resolve(
  fileURLToPath(new URL("../../test-fixtures/sample.docx", import.meta.url)),
);

describe("docxExtractor", () => {
  it("describes referenced images using their verified names and sizes without reading the bytes", async () => {
    const image = Buffer.alloc(4096, 42);
    const data = await createDocx([
      { kind: "image", text: "Fixture chart", path: "fixture.png" },
      { kind: "image", text: "Another chart", path: "another.png" },
      { kind: "paragraph", text: "Tail paragraph" },
    ], { images: new Map([
      ["fixture.png", { data: image, name: "fixture.png", info: { kind: "png", width: 1, height: 1 } }],
      ["another.png", { data: image.subarray(0, 2048), name: "another.png", info: { kind: "png", width: 1, height: 1 } }],
    ]) });
    const load = JSZip.loadAsync.bind(JSZip);
    const mediaReads: Array<() => number> = [];
    const read = vi.spyOn(JSZip, "loadAsync").mockImplementation(async (...args) => {
      const zip = await load(...args);
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || !entry.name.startsWith("word/media/")) continue;
        const readEntry = vi.spyOn(entry, "async");
        mediaReads.push(() => readEntry.mock.calls.length);
      }
      return zip;
    });
    try {
      const result = await docxExtractor({ data, sourcePath: "fixture.docx" });
      const text = result.text.replace(/\\([.()])/g, "$1");
      expect(text).toContain("image1.png (4096 bytes)");
      expect(text).toContain("image2.png (2048 bytes)");
      expect(result.text).toContain("Fixture chart");
      expect(result.text).toContain("Tail paragraph");
      expect(result.text.length).toBeLessThan(600);
      expect(result.text).not.toContain("data:");
      expect(mediaReads.map(calls => calls())).toEqual([0, 0]);
    } finally {
      read.mockRestore();
    }
  });
  it("validates a DOCX with stored media without regenerating its buffer", async () => {
    const zip = await JSZip.loadAsync(await readFile(FIXTURE_PATH));
    zip.file("word/media/fixture.bin", Buffer.alloc(128 * 1024, 41), { compression: "STORE" });
    const data = await zip.generateAsync({ type: "nodebuffer" });
    const regenerate = vi.spyOn(JSZip.prototype, "generateAsync");
    try {
      const result = await docxExtractor({ data, sourcePath: FIXTURE_PATH });
      expect(result.text).toContain("Document Title");
      expect(regenerate).not.toHaveBeenCalled();
    } finally {
      regenerate.mockRestore();
    }
  });
  it("extracts headings as markdown with body paragraphs", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await docxExtractor({ data, sourcePath: FIXTURE_PATH });
    expect(result.format).toBe("docx");
    // mammoth maps Heading 1 → #, Heading 2 → ##
    expect(result.text).toMatch(/^# Document Title/m);
    expect(result.text).toMatch(/^## Introduction/m);
    expect(result.text).toMatch(/sacred rites of the Omnissiah/);
    expect(result.text).toMatch(/Second paragraph: all systems nominal/);
  });

  it("returns raw text (no markdown) when includeTables=false", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await docxExtractor({
      data,
      sourcePath: FIXTURE_PATH,
      includeTables: false,
    });
    expect(result.text).not.toMatch(/^#/m);
    expect(result.text).toContain("Document Title");
    expect(result.text).toContain("Introduction");
  });

  it("collects mammoth warnings/errors into warnings[]", async () => {
    const data = await readFile(FIXTURE_PATH);
    const result = await docxExtractor({ data, sourcePath: FIXTURE_PATH });
    // Warnings may or may not be empty depending on the fixture; the contract
    // is simply that it's an array.
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});
