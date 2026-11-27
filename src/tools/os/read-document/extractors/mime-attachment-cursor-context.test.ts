import { expect, it } from "vitest";
import { emlExtractor } from "./email-extractor.js";

it("explains the transition to attachment lines past the last MIME body", async () => {
  const body = (value: string) => "Content-Type: text/plain\r\n\r\n" + value;
  const attachment = (name: string) => "Content-Type: application/octet-stream\r\n" +
    "Content-Disposition: attachment; filename=" + name + "\r\n\r\nsmall";
  const parts = [body("One"), attachment("first.bin"), body("Two"), body("Three"), attachment("second.bin")];
  const data = Buffer.from('Content-Type: multipart/mixed; boundary="parts"\r\n\r\n' +
    parts.map((part) => "--parts\r\n" + part + "\r\n").join("") + "--parts--");
  const result = await emlExtractor({ data, sourcePath: "fixture.eml", pagesFrom: 5 });
  expect(result.text).toContain("second.bin");
  expect(result.text).not.toContain("first.bin");
  expect(result.warnings).toContainEqual(expect.stringMatching(/attachment list.*resum.*body parts end at part 3/i));
});
