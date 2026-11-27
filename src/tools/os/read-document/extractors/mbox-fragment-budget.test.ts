import { expect, it } from "vitest";
import { mboxExtractor } from "./email-extractor.js";

it("shares the extraction budget across messages in an mbox slice", async () => {
  const message = (n: number) =>
    "From sender@example.test Mon Jan 1 00:00:00 2024\n" +
    "Content-Type: text/html\n\n<h2>Message " + n + "</h2>";
  const data = Buffer.from(Array.from({ length: 140 }, (_, n) => message(n)).join("\n\n"));
  const result = await mboxExtractor({ data, sourcePath: "mailbox.mbox", maxBytes: 170 });
  expect(result.pageCount).toBe(140);
  expect(result.text).toContain("## Message 0");
  expect(result.text).not.toContain("## Message 139");
  expect(result.pagesExtracted).toEqual([1, 2, 3, 4, 5]);
  expect(result.warnings).toContainEqual(expect.stringMatching(/mbox.*budget.*pagesFrom/i));

  const tail = await mboxExtractor({ data, sourcePath: "mailbox.mbox", pagesFrom: 139 });
  expect(tail.pagesExtracted).toEqual([139, 140]);
  expect(tail.text).toContain("## Message 139");
  expect(tail.warnings).toEqual([]);
});
