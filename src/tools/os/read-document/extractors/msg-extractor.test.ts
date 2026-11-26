import { describe, expect, it } from "vitest";

import { CfbError, openCfb } from "./cfb-reader.js";
import { msgExtractor } from "./msg-extractor.js";

// ------------------------------------------------------------------------
// Minimal MS-CFB writer (version 3, 512-byte sectors), test-only. Streams
// under 4096 bytes go to the mini stream, larger ones to regular sectors,
// so both read paths are exercised. Siblings are chained through `right`
// links rather than balanced as a red-black tree: readers do not depend
// on the balancing, only on the links.
// ------------------------------------------------------------------------

type Node = { name: string; data: Buffer } | { name: string; children: Node[] };

const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;
const END = 0xfffffffe;
const FREE = 0xffffffff;
const NONE = 0xffffffff;

interface FlatEntry {
  name: string;
  type: 1 | 2 | 5;
  data?: Buffer;
  child: number;
  right: number;
  start: number;
  size: number;
}

interface Built {
  buffer: Buffer;
  dirStart: number;
}

function buildCfb(children: Node[], sectorSize = SECTOR): Built {
  const entries: FlatEntry[] = [
    { name: "Root Entry", type: 5, child: NONE, right: NONE, start: END, size: 0 },
  ];
  const addChildren = (parent: number, nodes: Node[]) => {
    let prev = -1;
    for (const node of nodes) {
      const idx = entries.length;
      entries.push({
        name: node.name,
        type: "data" in node ? 2 : 1,
        data: "data" in node ? node.data : undefined,
        child: NONE,
        right: NONE,
        start: END,
        size: "data" in node ? node.data.length : 0,
      });
      if (prev === -1) entries[parent]!.child = idx;
      else entries[prev]!.right = idx;
      prev = idx;
      if (!("data" in node)) addChildren(idx, node.children);
    }
  };
  addChildren(0, children);

  // Mini stream layout.
  const miniChunks: Buffer[] = [];
  const miniFat: number[] = [];
  const big: FlatEntry[] = [];
  for (const e of entries) {
    if (e.type !== 2 || !e.data || e.data.length === 0) continue;
    if (e.data.length >= CUTOFF) {
      big.push(e);
      continue;
    }
    const n = Math.ceil(e.data.length / MINI);
    e.start = miniFat.length;
    for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? END : miniFat.length + 1);
    const padded = Buffer.alloc(n * MINI);
    e.data.copy(padded);
    miniChunks.push(padded);
  }
  const miniStream = Buffer.concat(miniChunks);

  const dirSectors = Math.ceil((entries.length * 128) / sectorSize);
  const miniFatSectors = Math.ceil((miniFat.length * 4) / sectorSize);
  const miniStreamSectors = Math.ceil(miniStream.length / sectorSize);
  const bigSectors = big.map((e) => Math.ceil(e.data!.length / sectorSize));
  const payload = dirSectors + miniFatSectors + miniStreamSectors + bigSectors.reduce((a, b) => a + b, 0);
  let fatSectors = 1;
  while (fatSectors * (sectorSize / 4) < payload + fatSectors) fatSectors++;
  if (fatSectors > 109) throw new Error("fixture exceeds the header FAT capacity");

  const fat: number[] = [];
  for (let i = 0; i < fatSectors; i++) fat.push(0xfffffffd);
  const run = (count: number): number => {
    if (count === 0) return END;
    const start = fat.length;
    for (let i = 0; i < count; i++) fat.push(i === count - 1 ? END : fat.length + 1);
    return start;
  };
  const dirStart = run(dirSectors);
  const miniFatStart = run(miniFatSectors);
  const miniStreamStart = run(miniStreamSectors);
  big.forEach((e, i) => {
    e.start = run(bigSectors[i]!);
  });
  entries[0]!.start = miniStream.length > 0 ? miniStreamStart : END;
  entries[0]!.size = miniStream.length;

  const sectors = fat.length;
  const out = Buffer.alloc(sectorSize * (sectors + 1));
  const at = (id: number) => (id + 1) * sectorSize;

  // Header.
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(out, 0);
  out.writeUInt16LE(0x3e, 0x18);
  out.writeUInt16LE(sectorSize === 4096 ? 4 : 3, 0x1a);
  out.writeUInt16LE(0xfffe, 0x1c);
  out.writeUInt16LE(sectorSize === 4096 ? 12 : 9, 0x1e);
  out.writeUInt16LE(6, 0x20);
  out.writeUInt32LE(fatSectors, 0x2c);
  out.writeUInt32LE(dirStart, 0x30);
  out.writeUInt32LE(CUTOFF, 0x38);
  out.writeUInt32LE(miniFatStart, 0x3c);
  out.writeUInt32LE(miniFatSectors, 0x40);
  out.writeUInt32LE(END, 0x44);
  out.writeUInt32LE(0, 0x48);
  for (let i = 0; i < 109; i++) out.writeUInt32LE(i < fatSectors ? i : FREE, 0x4c + i * 4);

  // FAT.
  for (let i = 0; i < fatSectors * (sectorSize / 4); i++) {
    out.writeUInt32LE(i < fat.length ? fat[i]! : FREE, sectorSize + i * 4);
  }
  // Directory.
  entries.forEach((e, i) => {
    const off = at(dirStart) + i * 128;
    const name = Buffer.from(`${e.name}\0`, "utf16le");
    name.copy(out, off);
    out.writeUInt16LE(name.length, off + 0x40);
    out[off + 0x42] = e.type;
    out[off + 0x43] = 1;
    out.writeUInt32LE(NONE, off + 0x44);
    out.writeUInt32LE(e.right, off + 0x48);
    out.writeUInt32LE(e.child, off + 0x4c);
    out.writeUInt32LE(e.start, off + 0x74);
    out.writeUInt32LE(e.size, off + 0x78);
  });
  for (let i = entries.length; i < dirSectors * (sectorSize / 128); i++) {
    const off = at(dirStart) + i * 128;
    out.writeUInt32LE(NONE, off + 0x44);
    out.writeUInt32LE(NONE, off + 0x48);
    out.writeUInt32LE(NONE, off + 0x4c);
  }
  // Mini FAT, mini stream, big streams.
  miniFat.forEach((v, i) => out.writeUInt32LE(v, at(miniFatStart) + i * 4));
  for (let i = miniFat.length; i < miniFatSectors * (sectorSize / 4); i++) {
    out.writeUInt32LE(FREE, at(miniFatStart) + i * 4);
  }
  miniStream.copy(out, at(miniStreamStart));
  for (const e of big) e.data!.copy(out, at(e.start));

  return { buffer: out, dirStart };
}

// --------------------------------------------------------- .msg helpers

const u = (id: number) => `__substg1.0_${id.toString(16).toUpperCase().padStart(4, "0")}001F`;
const a = (id: number) => `__substg1.0_${id.toString(16).toUpperCase().padStart(4, "0")}001E`;
const b = (id: number) => `__substg1.0_${id.toString(16).toUpperCase().padStart(4, "0")}0102`;
const str = (id: number, value: string): Node => ({ name: u(id), data: Buffer.from(value, "utf16le") });

function props(headerSize: number, rows: Array<[number, number, Buffer]>): Node {
  const buf = Buffer.alloc(headerSize + rows.length * 16);
  rows.forEach(([id, type, value], i) => {
    const off = headerSize + i * 16;
    buf.writeUInt32LE(((id << 16) | type) >>> 0, off);
    buf.writeUInt32LE(6, off + 4);
    value.copy(buf, off + 8, 0, 8);
  });
  return { name: "__properties_version1.0", data: buf };
}

const long = (n: number) => {
  const v = Buffer.alloc(8);
  v.writeUInt32LE(n, 0);
  return v;
};
const filetime = (ms: number) => {
  const v = Buffer.alloc(8);
  v.writeBigUInt64LE((BigInt(ms) + 11644473600000n) * 10000n, 0);
  return v;
};

const SENT = Date.UTC(2026, 10, 18, 9, 30, 0);

function sampleMessage(body: string): Node[] {
  return [
    props(32, [[0x0039, 0x0040, filetime(SENT)]]),
    str(0x0037, "Quarterly report: Привет"),
    str(0x0c1a, "Ann Lee"),
    str(0x0c1f, "/O=EXCHANGELABS/OU=EXCHANGE/CN=RECIPIENTS/CN=ANN"),
    str(0x5d01, "ann@example.com"),
    str(0x0e04, "Bob Stone; Cara Diaz"),
    str(0x1000, body),
    {
      name: "__recip_version1.0_#00000000",
      children: [
        props(8, [[0x0c15, 0x0003, long(1)]]),
        str(0x3001, "Bob Stone"),
        str(0x39fe, "bob@example.com"),
      ],
    },
    {
      name: "__recip_version1.0_#00000001",
      children: [
        props(8, [[0x0c15, 0x0003, long(2)]]),
        str(0x3001, "Cara Diaz"),
        str(0x3003, "cara@example.com"),
      ],
    },
    {
      name: "__attach_version1.0_#00000000",
      children: [
        props(8, [[0x3705, 0x0003, long(1)]]),
        str(0x3704, "REPORT~1.PDF"),
        str(0x3707, "report-q3.pdf"),
        str(0x370e, "application/pdf"),
        { name: b(0x3701), data: Buffer.alloc(2048, 7) },
      ],
    },
  ];
}

async function extract(data: Buffer) {
  return msgExtractor({ data, sourcePath: "/tmp/mail.msg" });
}

describe("cfb reader", () => {
  it("rejects a repeated sector before a fixed-size stream can copy it twice", () => {
    const { buffer, dirStart } = buildCfb([{ name: "fixture", data: Buffer.alloc(CUTOFF) }]);
    const start = buffer.readUInt32LE((dirStart + 1) * SECTOR + 128 + 0x74);
    buffer.writeUInt32LE(start, SECTOR + start * 4);
    const cfb = openCfb(buffer);
    expect(() => cfb.read(cfb.entry(1))).toThrow(/cycle|repeated sector/i);
  }, 1000);

  it("shares a work budget between directory entries pointing to the same stream", () => {
    const { buffer, dirStart } = buildCfb([
      { name: "one", data: Buffer.alloc(CUTOFF) }, { name: "two", data: Buffer.alloc(0) },
      { name: "three", data: Buffer.alloc(0) },
    ]);
    const first = (dirStart + 1) * SECTOR + 128;
    for (const offset of [128, 256]) buffer.copy(buffer, first + offset + 0x74, first + 0x74, first + 0x7c);
    const cfb = openCfb(buffer);
    expect(cfb.read(cfb.entry(1))).toHaveLength(CUTOFF);
    expect(() => { cfb.read(cfb.entry(2)); cfb.read(cfb.entry(3)); }).toThrow(/work budget/i);
  }, 1000);

  it("reads streams from both the mini stream and regular sectors", () => {
    const small = Buffer.from("tiny");
    const large = Buffer.alloc(9000, 0x41);
    const { buffer } = buildCfb([
      { name: "small", data: small },
      { name: "dir", children: [{ name: "large", data: large }] },
    ]);
    const cfb = openCfb(buffer);
    expect(cfb.read(cfb.child(cfb.root, "SMALL")!)).toEqual(small);
    const dir = cfb.child(cfb.root, "dir")!;
    expect(dir.type).toBe("storage");
    expect(cfb.read(cfb.child(dir, "large")!)).toEqual(large);
  });

  it("pads the unused mini-FAT entries through the end of a v4 sector", () => {
    const sectorSize = 4096;
    const { buffer } = buildCfb([{ name: "Small", data: Buffer.from("fixture") }], sectorSize);
    const sector = buffer.readUInt32LE(0x3c);
    expect(buffer.readUInt32LE((sector + 2) * sectorSize - 4)).toBe(FREE);
  });

  it("rejects files that are not compound files", () => {
    expect(() => openCfb(Buffer.from("From: a@b.c\r\n\r\nhi"))).toThrow(CfbError);
    expect(() => openCfb(Buffer.alloc(1024))).toThrow(/bad signature/);
  });

  it("fails cleanly on a looping sector chain instead of hanging", () => {
    const { buffer, dirStart } = buildCfb([{ name: "s", data: Buffer.from("x") }]);
    // Point the directory's FAT entry back at itself.
    buffer.writeUInt32LE(dirStart, SECTOR + dirStart * 4);
    expect(() => openCfb(buffer)).toThrow(/loops/);
  });

  it("fails cleanly on a truncated file", () => {
    const { buffer } = buildCfb(sampleMessage("hello"));
    expect(() => openCfb(buffer.subarray(0, 600))).toThrow(CfbError);
  });

  it("refuses a stream whose claimed size exceeds the file, without allocating it", () => {
    const { buffer } = buildCfb([{ name: "s", data: Buffer.from("x") }]);
    const off = buffer.indexOf(Buffer.from("s\0", "utf16le"), SECTOR * 2);
    buffer.writeUInt32LE(0x7fffffff, off + 0x78);
    const cfb = openCfb(buffer);
    expect(() => cfb.read(cfb.child(cfb.root, "s")!)).toThrow(/more than the file/);
  });

  it("survives cyclic sibling links in the directory", () => {
    const { buffer, dirStart } = buildCfb([
      { name: "one", data: Buffer.from("1") },
      { name: "two", data: Buffer.from("2") },
    ]);
    // Entry 2's right sibling -> entry 1, which already points to entry 2.
    buffer.writeUInt32LE(1, (dirStart + 1) * SECTOR + 2 * 128 + 0x48);
    const cfb = openCfb(buffer);
    expect([...cfb.root.children.keys()].sort()).toEqual(["ONE", "TWO"]);
  });
});

describe("msg extractor", () => {
  it("keeps Outlook table layout and its link in a 2.2 MB styled body", async () => {
    const style = "x".repeat(2_200_000);
    const html = Buffer.from(`<div style="${style}">` + "<table><tr><td>".repeat(6) +
      '<a href="https://example.test/report">Report</a>' + "</td></tr></table>".repeat(6) + "</div>");
    const { buffer } = buildCfb([{ name: b(0x1013), data: html }], 4096);
    const started = performance.now();
    const result = await extract(buffer);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.text).toContain("[Report](https://example.test/report)");
    expect(result.text).toContain("| --- |");
    expect(result.warnings.join("\n")).not.toContain("Showing plain text");
  });
  it("keeps the final Outlook paragraph after large inline styles and images", async () => {
    const decoration = "x".repeat(410 * 1024);
    const html = Buffer.from(`<p style="${decoration}">Visible intro</p>` +
      `<img src="data:image/png;base64,${decoration}" alt="Logo"><p>Final Outlook paragraph</p>`);
    const { buffer } = buildCfb([{ name: b(0x1013), data: html }], 4096);
    const result = await extract(buffer);
    expect(result.text).toContain("Final Outlook paragraph");
    expect(result.text).not.toContain("data:image");
    expect(result.warnings).toEqual([]);
  });
  it("bounds the conversion of an eight MiB HTML body and keeps the visible start", async () => {
    const head = "<html><body><p>Monthly report</p><p>";
    const tail = "</p></body></html>";
    const html = Buffer.from(head + "a".repeat(8 * 1024 * 1024 - head.length - tail.length) + tail);
    const { buffer } = buildCfb([{ name: b(0x1013), data: html }], 4096);
    const start = performance.now();
    const result = await extract(buffer);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result.text).toContain("Monthly report");
    expect(result.text.length).toBeLessThan(1024 * 1024);
    expect(result.warnings.join("\n")).toMatch(/HTML.*truncat/i);
  });
  it("preserves the end of a two MiB UTF-16 message body", async () => {
    const body = "a".repeat(1024 * 1024 - 12) + "\nfixture-end";
    const result = await extract(buildCfb([str(0x1000, body)]).buffer);
    expect(result.text.length).toBe(body.length);
    expect(result.text.endsWith("fixture-end")).toBe(true);
    expect(result.warnings.some(warning => warning.includes("too large"))).toBe(false);
  });

  it("prefers the complete plain body when its HTML alternative would be cut", async () => {
    const html = Buffer.from("<p>" + "HTML alternative ".repeat(30_000) + "</p>");
    const result = await extract(buildCfb([str(0x1000, "Complete plain-text report"), { name: b(0x1013), data: html }]).buffer);
    expect(result.text).toBe("Complete plain-text report");
    expect(result.warnings).toEqual([]);
  });

  it("omits attachment sizes larger than the compound file", async () => {
    const { buffer } = buildCfb(sampleMessage("Body text"));
    const offset = buffer.indexOf(Buffer.from(b(0x3701) + "\0", "utf16le"));
    expect(offset).toBeGreaterThan(0);
    buffer.writeUInt32LE(buffer.length + 1024, offset + 0x78);
    expect((await extract(buffer)).text).toContain("- report-q3.pdf (application/pdf)");
  });
  it("skips oversized string properties and caps recipient and attachment traversal", async () => {
    const subject = { name: "__substg1.0_0037001F", data: Buffer.alloc(1024 * 1024 + 2, 0x41) };
    const { buffer } = buildCfb([subject, ...Array.from({ length: 1001 }, (_, i) => [
      { name: `__recip_version1.0_#${i.toString(16).padStart(8, "0")}`, children: [] },
      { name: `__attach_version1.0_#${i.toString(16).padStart(8, "0")}`, children: [] },
    ]).flat()]);
    const result = await msgExtractor({ data: buffer, sourcePath: "fixture.msg" });
    expect(result.text.includes("Subject:")).toBe(false);
    expect(result.warnings.join("\n")).toMatch(/property.*too large/i);
    expect(result.warnings.join("\n")).toMatch(/recipients.*1000/i);
    expect(result.warnings.join("\n")).toMatch(/attachments.*1000/i);
  }, 1000);

  it("renders headers, a long plain body and attachments like the .eml reader", async () => {
    const body = "Hi Bob,\r\n\r\n" + "Numbers attached. ".repeat(200).trim() + "\r\n\r\nAnn";
    const result = await extract(buildCfb(sampleMessage(body)).buffer);
    expect(result.format).toBe("msg");
    expect(result.warnings).toEqual([]);
    expect(result.text).toBe(
      [
        "From: Ann Lee <ann@example.com>",
        "To: Bob Stone <bob@example.com>",
        "Cc: Cara Diaz <cara@example.com>",
        `Date: ${new Date(SENT).toUTCString()}`,
        "Subject: Quarterly report: Привет",
        "",
        body.replace(/\r\n/g, "\n"),
        "",
        "Attachments:",
        "- report-q3.pdf (application/pdf, 2 KB)",
      ].join("\n"),
    );
  });

  it("decodes ANSI strings by code page and falls back to the HTML body", async () => {
    const privet = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in cp1251
    const html = Buffer.from(
      "<html><head><style>p{}</style></head><body><p>Hello <b>team</b></p><table><tr><td>a</td><td>b</td></tr></table></body></html>",
      "utf8",
    );
    const { buffer } = buildCfb([
      props(32, [
        [0x3ffd, 0x0003, long(1251)],
        [0x3fde, 0x0003, long(65001)],
      ]),
      { name: a(0x0037), data: Buffer.concat([privet, Buffer.from([0])]) },
      { name: a(0x0c1a), data: Buffer.from("Ivan") },
      { name: a(0x0e04), data: Buffer.from("Team list") },
      { name: b(0x1013), data: html },
    ]);
    const result = await extract(buffer);
    expect(result.text).toContain("From: Ivan\nTo: Team list\nSubject: Привет");
    expect(result.text).toContain("Hello **team**");
    expect(result.text).toContain("| a | b |");
    expect(result.text).not.toContain("<p>");
  });

  it("renders an attached Outlook item as a nested message", async () => {
    const { buffer } = buildCfb([
      props(32, []),
      str(0x0037, "Fwd: lunch"),
      str(0x1000, "See below."),
      {
        name: "__attach_version1.0_#00000000",
        children: [
          props(8, [[0x3705, 0x0003, long(5)]]),
          str(0x3001, "lunch"),
          {
            name: "__substg1.0_3701000D",
            children: [props(24, []), str(0x0037, "lunch"), str(0x1000, "Noon at the usual place.")],
          },
        ],
      },
    ]);
    const result = await extract(buffer);
    expect(result.text).toBe(
      "Subject: Fwd: lunch\n\nSee below.\n\n--- attached message ---\nSubject: lunch\n\nNoon at the usual place.",
    );
  });

  it("uses the transport headers for the date when no time property is set", async () => {
    const { buffer } = buildCfb([
      str(0x0037, "Hi"),
      str(0x007d, "Received: x\r\nDate: Tue, 17 Nov 2026 08:00:00 +0000\r\nSubject: Hi\r\n"),
    ]);
    const result = await extract(buffer);
    expect(result.text).toBe("Date: Tue, 17 Nov 2026 08:00:00 +0000\nSubject: Hi");
  });

  it("keeps going with a warning when one property stream is corrupt", async () => {
    const { buffer } = buildCfb(sampleMessage("Body text"));
    const off = buffer.indexOf(Buffer.from(`${u(0x0037)}\0`, "utf16le"));
    expect(off).toBeGreaterThan(0);
    buffer.writeUInt32LE(0x7fffffff, off + 0x78);
    const result = await extract(buffer);
    expect(result.text).not.toContain("Subject:");
    expect(result.text).toContain("Body text");
    expect(result.warnings.join("\n")).toMatch(/skipped unreadable property __substg1\.0_0037001F/);
  });

  it("warns when the body exists only as compressed RTF", async () => {
    const { buffer } = buildCfb([str(0x0037, "RTF only"), { name: b(0x1009), data: Buffer.alloc(40, 1) }]);
    const result = await extract(buffer);
    expect(result.text).toBe("Subject: RTF only");
    expect(result.warnings).toContain("message body is stored only as compressed RTF, which is not read");
  });

  it("throws a clear error for files that are not .msg containers", async () => {
    await expect(extract(Buffer.from("not an outlook file at all"))).rejects.toThrow(
      /not a readable Outlook \.msg file/,
    );
    const truncated = buildCfb(sampleMessage("x")).buffer.subarray(0, 700);
    await expect(extract(truncated)).rejects.toThrow(/not a readable Outlook \.msg file/);
  });
});
