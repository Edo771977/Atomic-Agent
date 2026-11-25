import { resolve } from "node:path";
import { expect, it } from "vitest";
import { readTaintTargets } from "./read-taint-targets.js";

it("includes a Word picture in the fork's read taint before a write", () => {
  const root = resolve("/fixture");
  const picture = resolve(root, "restricted", "picture.png");
  expect(readTaintTargets("os.fs.docx", {
    op: "create", path: "result.docx", blocks: [`![picture](${picture.replaceAll("\\", "/")})`],
  }, root)).toContain(picture);
});
