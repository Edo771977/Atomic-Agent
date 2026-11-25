import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { findSessionReadOutside } from "./read-scope.js";
import { readTaintTargets } from "./read-taint-targets.js";
import { findStateSecretReads } from "./state-secrets.js";

it("includes a Word picture in the fork's read taint before a write", () => {
  const root = resolve("/fixture");
  const picture = resolve(root, "restricted", "picture.png");
  expect(readTaintTargets("os.fs.docx", {
    op: "create", path: "result.docx", blocks: [`![picture](${picture.replaceAll("\\", "/")})`],
  }, root)).toContain(picture);
});

it.each([
  ["DOCX", "os.fs.docx", (path: string) => ({ op: "create", path: "out.docx", blocks: [`![fixture](${path})`] })],
  ["PPTX", "os.fs.write_pptx", (path: string) => ({ slides: [{ image: path }] })],
] as const)("applies all three file guards to %s picture targets", (_, tool, args) => {
  const root = resolve("/fixture", "workspace");
  const protectedDir = resolve(root, "..", "restricted");
  const image = resolve(protectedDir, "picture.png");
  const context = { sessionId: "fixture", workingDir: root };
  for (const input of ["folder:fixture/../../restricted/picture.png", pathToFileURL(image).href]) {
    expect(findSessionReadOutside(tool, args(input), context, [root])).toBe(image);
    expect(readTaintTargets(tool, args(input), root)).toContain(image);
    expect(findStateSecretReads(tool, args(input), context, { stateDir: protectedDir, files: [image] })).toContain(image);
  }
});

it("keeps non-file browser URLs out of the filesystem guards", () => {
  const root = resolve("/fixture", "workspace");
  const context = { sessionId: "fixture", workingDir: root };
  for (const url of ["https://example.test/index", "data:text/plain,a", "blob:https://example.test/id", "about:blank"]) {
    expect(findSessionReadOutside("browser.navigate", { url }, context, [root])).toBeNull();
    expect(readTaintTargets("browser.navigate", { url }, root)).toEqual([]);
    expect(findStateSecretReads("browser.navigate", { url }, context, { stateDir: root, files: [] })).toEqual([]);
  }
});

it("classifies an unrecognized scheme as a path for each browser read guard", () => {
  const root = resolve("/fixture", "workspace");
  const path = resolve(root, "..", "restricted", "fixture.txt");
  const context = { sessionId: "fixture", workingDir: root };
  const args = { url: "folder:fixture/../../restricted/fixture.txt" };
  expect(findSessionReadOutside("browser.navigate", args, context, [root])).toBe(path);
  expect(readTaintTargets("browser.navigate", args, root)).toEqual([path]);
  expect(findStateSecretReads("browser.navigate", args, context, { stateDir: root, files: [path] })).toEqual([path]);
});
