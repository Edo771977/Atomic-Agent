import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { EOL, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROJECT_LIMITS } from "./project-limits.js";
import { readProjectLessons } from "./project-lessons.js";

describe("project lesson files", () => {
  let folder: string;
  let dir: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "project-lessons-"));
    dir = join(folder, ".atomic", "project", "lessons");
  });

  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  function lesson(id: string, headings = ["Deciso", "Provato e scartato", "Attenzione"], touches = "[]"): string {
    return [
      "---", `id: ${id}`, 'title: "Use SQLite: local storage"', "source: person",
      "from: milestone m2, run r7 # evidence", `touches: ${touches}`, "status: active", "always: true", "---",
      ...headings.flatMap((heading) => [`## ${heading}`, "some text"]),
    ].join(EOL);
  }

  function write(file: string, text: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text);
  }

  it.each([
    ["Deciso", "Provato e scartato", "Attenzione"],
    ["Decided", "Tried and ruled out", "Watch out"],
  ])("reads a complete lesson headed %s without granting approval", (...headings) => {
    write("storage.md", lesson("storage", headings, `[${join("src", "storage.ts")}, 'docs/with,comma.md']`));
    expect(readProjectLessons(folder)).toEqual({ lessons: [{
      id: "storage", title: "Use SQLite: local storage", from: "milestone m2, run r7",
      source: "person", declaredStatus: "active", approvedByPerson: false, hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      always: true, touches: [join("src", "storage.ts"), "docs/with,comma.md"],
      sections: { decided: "some text", triedAndRuledOut: "some text", watchOut: "some text" },
    }], problems: [] });
  });

  it.each([
    ["bad front matter", (text: string) => text.replace("source: person", "source person"), /front matter/i],
    ["duplicate field", (text: string) => text.replace("source: person", ["source: person", "source: director"].join(EOL)), /duplicate/i],
    ["mismatching id", (text: string) => text.replace("id: storage", "id: other"), /file name/i],
    ["missing section", (text: string) => text.replace("## Attenzione", "## Other"), /section/i],
    ["bad boolean", (text: string) => text.replace("always: true", 'always: "true"'), /always/i],
  ])("rejects the entire file with %s", (_label, change, reason) => {
    write("storage.md", change(lesson("storage")));
    expect(readProjectLessons(folder)).toEqual({
      lessons: [], problems: [{ file: "storage.md", reason: expect.stringMatching(reason) }],
    });
  });

  it("rejects all files declaring the same id", () => {
    write("storage.md", lesson("storage"));
    write("copy.md", lesson("storage"));
    const result = readProjectLessons(folder);
    expect(result.lessons).toEqual([]);
    expect(result.problems).toEqual(["copy.md", "storage.md"].map((file) => ({
      file, reason: expect.stringMatching(/duplicate id/i),
    })));
  });

  it.each([join("..", "outside"), "src/../../outside", "/etc/example", "C:\\outside", "C:outside", "\\\\server\\share"])(
    "rejects a touches path outside the project: %s", (path) => {
      write("storage.md", lesson("storage", undefined, `[${path}]`));
      expect(readProjectLessons(folder)).toEqual({
        lessons: [], problems: [{ file: "storage.md", reason: expect.stringMatching(/touches/i) }],
      });
    },
  );

  it("rejects oversized files", () => {
    write("storage.md", lesson("storage") + "x".repeat(PROJECT_LIMITS.lessonFileBytes));
    expect(readProjectLessons(folder)).toEqual({
      lessons: [], problems: [{ file: "storage.md", reason: expect.stringMatching(/bytes/i) }],
    });
  });

  it("refuses to load a directory beyond the file limit", () => {
    for (let i = 0; i <= PROJECT_LIMITS.lessonFiles; i++) write(`lesson-${i}.md`, lesson(`lesson-${i}`));
    expect(readProjectLessons(folder)).toEqual({
      lessons: [], problems: [{ file: "lessons", reason: expect.stringMatching(/files/i) }],
    });
  });

  it.each([["\u{E0061}", "E0061"], ["\u202E", "202E"]])("rejects invisible lesson text (%s)", (character, code) => {
    write("storage.md", lesson("storage").replace("## Deciso", "## Deciso\nInert " + character + " text"));
    expect(readProjectLessons(folder)).toEqual({
      lessons: [], problems: [{ file: "storage.md", reason: expect.stringContaining("U+" + code) }],
    });
  });

  it("reports symlinks among lesson entries", () => {
    write("storage.md", lesson("storage"));
    const outside = join(folder, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "linked.md"), lesson("linked"));
    if (process.platform === "win32") {
      symlinkSync(outside, join(dir, "linked.md"), "junction");
    } else {
      symlinkSync(join(outside, "linked.md"), join(dir, "linked.md"), "file");
    }
    expect(readProjectLessons(folder)).toMatchObject({
      lessons: [{ id: "storage" }], problems: [{ file: "linked.md", reason: expect.stringMatching(/symbolic link/i) }],
    });
  });

  it.each([[".atomic"], [".atomic", "project"], [".atomic", "project", "lessons"]])(
    "does not traverse a linked archive component (%s)", (...parts) => {
      const outside = join(folder, "outside");
      const nested = join(outside, ...[".atomic", "project", "lessons"].slice(parts.length));
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "linked.md"), lesson("linked"));
      const link = join(folder, ...parts);
      mkdirSync(join(folder, ...parts.slice(0, -1)), { recursive: true });
      symlinkSync(outside, link, "junction");
      expect(readProjectLessons(folder)).toEqual({
        lessons: [], problems: [{ file: "lessons", reason: expect.stringMatching(/symbolic link/i) }],
      });
    },
  );

  it("treats a missing lessons directory as an empty listing", () => {
    mkdirSync(join(folder, ".atomic", "project"), { recursive: true });
    expect(readProjectLessons(folder)).toEqual({ lessons: [], problems: [] });
  });
});
