import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";

const delimiter = "--fixture\r\n";
const plain = (text: string) => delimiter + "Content-Type: text/plain\r\n\r\n" + text + "\r\n";
const binary = (name: string) => "Content-Type: application/octet-stream\r\n" +
  "Content-Disposition: attachment; filename=" + name + "\r\n\r\nabc\r\n";
const forwarded = (name: string) => delimiter + "Content-Type: message/rfc822\r\n\r\n" +
  "Subject: Receipt\r\n" + binary(name);

it.each([100, 300, 1000])("recovers every whole attachment line when following %i-byte windows", async (maxBytes) => {
  const names = Array.from({ length: 100 }, (_, n) => "fixture-" + n + ".bin");
  const bodies = Array.from({ length: 200 }, (_, n) => "Body " + (n + 1) + " with a short note.");
  const chunks = bodies.map((body, n) =>
    plain(body) +
    (n % 2 ? "" : n % 4 ? delimiter + binary(names[n / 2]!) : forwarded(names[n / 2]!)));
  const data = Buffer.from('Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    chunks.join("") + "--fixture--");
  const seen = new Set<string>();
  const shownBodies: string[] = [];
  let pagesFrom = 1;
  for (let call = 0; call < 500; call++) {
    const result = await emlExtractor({ data, sourcePath: "mixed.eml", maxBytes, pagesFrom });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(maxBytes);
    shownBodies.push(...result.text.split("\n").filter((line) => line.startsWith("Body ")));
    for (const line of result.text.split("\n").filter((value) => value.startsWith("- "))) {
      const complete = /^- (fixture-\d+\.bin) \(application\/octet-stream, 3 B\)$/.exec(line);
      expect(complete).not.toBeNull();
      if (complete) seen.add(complete[1]!);
    }
    const cursor = result.warnings.map((value) => value.match(/pagesFrom=(\d+)/)?.[1]).find(Boolean);
    if (!cursor) break;
    expect(Number(cursor)).toBeGreaterThan(pagesFrom);
    pagesFrom = Number(cursor);
  }
  expect([...seen].sort()).toEqual(names.sort());
  expect(shownBodies).toEqual(bodies);
});

it("keeps an oversized attachment line pending until a larger window can display it", async () => {
  const name = "long-" + "x".repeat(180) + ".bin";
  const data = Buffer.from("Subject: Receipt\r\n" + binary(name).trimEnd());
  const small = await emlExtractor({ data, sourcePath: "receipt.eml", maxBytes: 100, pagesFrom: 1 });
  expect(small.text).toBe("");
  expect(small.warnings).toContainEqual(expect.stringMatching(/complete.*maxBytes.*pagesFrom=1/i));
  const wide = await emlExtractor({ data, sourcePath: "receipt.eml", maxBytes: 300 });
  expect(wide.text).toContain("Subject: Receipt");
  expect(wide.text).toContain("- " + name + " (application/octet-stream, 3 B)");
});

it("reports which mailbox message can be retried when its listing cannot fit", async () => {
  const data = Buffer.from("From reader@example.test Fri Nov 27 00:00:00 2026\n" +
    'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
    plain("First body") + delimiter + binary("long-" + "a".repeat(95) + ".bin") + "--fixture--");
  const small = await mboxExtractor({ data, sourcePath: "fixture.mbox", maxBytes: 100 });
  expect(small.text).toContain("First body");
  expect(small.text).not.toContain("long-");
  expect(small.warnings).toContainEqual(expect.stringMatching(/attachments.*maxBytes.*pagesFrom=1/i));
  const wide = await mboxExtractor({ data, sourcePath: "fixture.mbox", maxBytes: 300, pagesFrom: 1 });
  expect(wide.text).toContain("long-" + "a".repeat(95) + ".bin");
});
