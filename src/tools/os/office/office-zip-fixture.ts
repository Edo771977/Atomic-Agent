import JSZip from "jszip";

/** A tiny compressed fixture with an intentionally inconsistent size field. */
export async function withDeclaredOfficePartSize(input: Buffer, bytes: number): Promise<Buffer> {
  const zip = await JSZip.loadAsync(input);
  const part = "customXml/review-fixture.xml";
  zip.file(part, "synthetic fixture");
  const data = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const name = Buffer.from(part);
  const offset = data.lastIndexOf(name) - 46;
  if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error("fixture central directory entry not found");
  data.writeUInt32LE(bytes, offset + 24);
  return data;
}
