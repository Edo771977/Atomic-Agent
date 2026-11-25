import JSZip from "jszip";
import { expect, it } from "vitest";
import { loadBoundedOfficeZip } from "./bounded-office-zip.js";
import { withDeclaredOfficePartSize } from "../office/office-zip-fixture.js";

it("gives existing Office packages a 256 MiB default budget", async () => {
  const zip = new JSZip();
  const minimal = await zip.generateAsync({ type: "nodebuffer" });
  // The fixtures only claim these sizes. The compressed payload is tiny.
  const within = await withDeclaredOfficePartSize(minimal, 64 * 1024 * 1024);
  const over = await withDeclaredOfficePartSize(minimal, 256 * 1024 * 1024 + 1);
  await expect(loadBoundedOfficeZip(within)).rejects.toThrow(/does not match its uncompressed size/);
  await expect(loadBoundedOfficeZip(over)).rejects.toThrow(/uncompressed size limit \(268435456 bytes\)/);
});

it("caps the sum of inflated parts at a small fixture budget", async () => {
  const zip = new JSZip();
  zip.file("one.xml", "a".repeat(40));
  zip.file("two.xml", "b".repeat(40));
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await expect(loadBoundedOfficeZip(data, 79)).rejects.toThrow(/uncompressed size limit/i);
  const opened = await loadBoundedOfficeZip(data, 80);
  expect(await opened.file("two.xml")!.async("text")).toBe("b".repeat(40));
});

it("checks the actual deflate output against the claimed size", async () => {
  const zip = new JSZip();
  zip.file("part.xml", "a".repeat(512));
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const offset = data.lastIndexOf(Buffer.from("part.xml")) - 46;
  expect(data.readUInt32LE(offset)).toBe(0x02014b50);
  data.writeUInt32LE(32, offset + 24);
  await expect(loadBoundedOfficeZip(data, 64)).rejects.toThrow(/part.xml.*uncompressed size/i);
});

it("repackages verified XML as stored bytes while preserving compressed media", async () => {
  const zip = new JSZip();
  const xml = "<row>fixture</row>".repeat(50);
  const media = Buffer.alloc(96 * 1024, 42);
  zip.file("xl/worksheets/sheet1.xml", xml);
  zip.file("xl/media/image1.bin", media);
  const fixture = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const bounded = await loadBoundedOfficeZip(fixture);
  const repacked = await bounded.generateAsync({ type: "nodebuffer", compression: "STORE" });
  // A repack should not write the 96 KiB of decoded media into its output.
  expect(repacked.byteLength).toBeLessThan(4 * 1024);
  const xmlOffset = repacked.lastIndexOf(Buffer.from("xl/worksheets/sheet1.xml")) - 46;
  expect(repacked.readUInt16LE(xmlOffset + 10)).toBe(0); // ZIP STORE
  const reopened = await JSZip.loadAsync(repacked);
  expect(await reopened.file("xl/worksheets/sheet1.xml")!.async("text")).toBe(xml);
  expect(await reopened.file("xl/media/image1.bin")!.async("nodebuffer")).toEqual(media);
});
