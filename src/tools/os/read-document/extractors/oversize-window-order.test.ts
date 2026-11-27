import { expect, it } from "vitest";
import { emlExtractor, mboxExtractor } from "./email-extractor.js";

it.each(["eml", "mbox"] as const)("defers an oversized %s item until its body begins a fresh window", async (format) => {
  const values = ["First body", "SECOND-BODY-START " + "x".repeat(500), "Third body",
    "FOURTH-BODY-START " + "z".repeat(600), "Fifth body"];
  const input = format === "eml"
    ? 'Content-Type: multipart/mixed; boundary="fixture"\r\n\r\n' +
      values.map((value) => "--fixture\r\nContent-Type: text/plain\r\n\r\n" + value + "\r\n").join("") + "--fixture--"
    : values.map((value, index) => "From sender@example.test Fri Nov 27 00:00:00 2026\n" +
      "Subject: Item " + (index + 1) + "\nContent-Type: text/plain\n\n" + value).join("\n\n");
  const extract = format === "eml" ? emlExtractor : mboxExtractor;
  const data = Buffer.from(input);
  let pagesFrom = 1;
  const shown: string[] = [];
  const cursors: number[] = [];
  for (let call = 0; call < 6; call++) {
    const result = await extract({ data, sourcePath: "fixture." + format, maxBytes: 100, pagesFrom });
    shown.push(result.text);
    const cursor = result.warnings.join("\n").match(/pagesFrom=(\d+)/)?.[1];
    if (!cursor) break;
    pagesFrom = Number(cursor);
    cursors.push(pagesFrom);
  }
  expect(cursors).toEqual([2, 3, 4, 5]);
  expect(shown[0]).not.toContain("SECOND-BODY-START");
  expect(shown[1]).toContain("SECOND-BODY-START");
  expect(shown[2]).toContain("Third body");
  expect(shown[3]).toContain("FOURTH-BODY-START");
  expect(shown[4]).toContain("Fifth body");
});
