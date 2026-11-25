import JSZip from "jszip";
import { expect, it } from "vitest";
import { loadBoundedOfficeZip } from "./bounded-office-zip.js";

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
