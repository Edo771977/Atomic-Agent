import {
  closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync,
} from "node:fs";
import { join, posix, resolve, win32 } from "node:path";

import { PROJECT_LIMITS } from "./project-limits.js";
import { PROJECT_STORE_DIR_PARTS } from "./project-store.js";

const SOURCES = ["correction", "milestone-failure", "person", "director"] as const;
const STATUSES = ["proposed", "active", "retired"] as const;
const FIELDS = new Set(["id", "title", "source", "from", "touches", "status", "always"]);
const HEADINGS = {
  decided: ["Deciso", "Decided"],
  triedAndRuledOut: ["Provato e scartato", "Tried and ruled out"],
  watchOut: ["Attenzione", "Watch out"],
} as const;

type Section = keyof typeof HEADINGS;

export interface ProjectLesson {
  id: string;
  title: string;
  source: typeof SOURCES[number];
  from?: string;
  touches: string[];
  declaredStatus: typeof STATUSES[number];
  always: boolean;
  /** Author content cannot grant approval. Phase 1 reads no decision record. */
  approvedByPerson: false;
  sections: Record<Section, string>;
}

export interface ProjectLessonProblem {
  file: string;
  reason: string;
}

export interface ProjectLessons {
  lessons: ProjectLesson[];
  problems: ProjectLessonProblem[];
}

// Flat YAML subset. Quotes protect hashes and list separators. See the session README.
function frontMatter(lines: string[]): { fields: Map<string, string>; body: string[] } {
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 0) throw new Error("Expected front matter between --- lines.");
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    const field = /^([a-z]+):[ \t]+(.*)$/.exec(line);
    if (field === null || !FIELDS.has(field[1]!)) throw new Error("Invalid or unknown front matter field.");
    const key = field[1]!;
    if (fields.has(key)) throw new Error("Duplicate front matter field: " + key + ".");
    fields.set(key, withoutComment(field[2]!).trim());
  }
  return { fields, body: lines.slice(end + 1) };
}

function withoutComment(value: string): string {
  const token = /"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^"'#]+/y;
  while (token.lastIndex < value.length) {
    const start = token.lastIndex;
    if (value[start] === "#" && (start === 0 || /\s/.test(value[start - 1]!))) {
      return value.slice(0, start);
    }
    if (token.exec(value) === null) throw new Error("Invalid quoting or hash in front matter.");
  }
  return value;
}

function textValue(raw: string, field: string): string {
  let value = raw;
  if (/^'(?:[^']|'')*'$/.test(raw)) {
    value = raw.slice(1, -1).replace(/''/g, "'");
  } else if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    try {
      value = JSON.parse(raw) as string;
    } catch {
      throw new Error("Invalid double-quoted value for " + field + ".");
    }
  } else if (/^[-?:](?:$|\s)|^[!&*{}[\]|>@%]|["']|:\s|:$/.test(raw)) {
    throw new Error("Unsupported scalar for " + field + ".");
  }
  if (value.trim() === "" || [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error("Expected non-empty single-line text for " + field + ".");
  }
  return value;
}

function enumValue<T extends string>(raw: string, values: readonly T[], field: string): T {
  const text = textValue(raw, field);
  const value = values.find((choice) => choice === text);
  if (value === undefined) throw new Error("Invalid " + field + ". Expected " + values.join(", ") + ".");
  return value;
}

function readTouches(raw: string): string[] {
  if (!raw.startsWith("[") || !raw.endsWith("]")) throw new Error("Expected an inline touches list.");
  let rest = raw.slice(1, -1).trim();
  const result: string[] = [];
  while (rest !== "") {
    const item = /^((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*|[^"',\][\r\n]+)(,|$)/.exec(rest);
    if (item === null) throw new Error("Invalid item in the touches list.");
    const path = textValue(item[1]!.trim(), "touches");
    const portable = path.replaceAll("\\", "/");
    const normalized = posix.normalize(portable);
    const ambiguousSegment = portable.split("/").some((part) => part !== "." && part !== ".." && /[. ]$/.test(part));
    if (path.length > PROJECT_LIMITS.lessonTouchPath || win32.isAbsolute(path) || path.includes(":") || ambiguousSegment ||
        normalized === ".." || normalized.startsWith("../")) {
      throw new Error("Each touches path must be relative to the project and at most " + PROJECT_LIMITS.lessonTouchPath + " characters.");
    }
    result.push(path);
    if (result.length > PROJECT_LIMITS.lessonTouches) {
      throw new Error("Too many touches paths. Limit: " + PROJECT_LIMITS.lessonTouches + ".");
    }
    rest = rest.slice(item[0].length).trimStart();
    if (item[2] === "," && rest === "") throw new Error("Trailing comma in the touches list.");
  }
  return result;
}

function readSections(body: string[]): Record<Section, string> {
  const sections: Partial<Record<Section, string[]>> = {};
  let current: Section | undefined;
  let fence: string | undefined;
  for (const line of body) {
    const marker = /^ {0,3}(~{3,}|\x60{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      if (marker !== null && marker[1]!.startsWith(fence) && marker[2]!.trim() === "") fence = undefined;
    } else if (marker !== null) {
      fence = marker[1]!;
    } else {
      const heading = /^ {0,3}##[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)?.[1];
      if (heading !== undefined) {
        current = (Object.keys(HEADINGS) as Section[]).find(
          (section) => HEADINGS[section].some((name) => name === heading),
        );
        if (current !== undefined) {
          if (sections[current] !== undefined) throw new Error("Duplicate section: " + heading + ".");
          sections[current] = [];
        }
        continue;
      }
    }
    if (current !== undefined) sections[current]!.push(line);
  }
  const { decided, triedAndRuledOut, watchOut } = sections;
  if (decided === undefined || triedAndRuledOut === undefined || watchOut === undefined) {
    throw new Error("Expected all three sections: Deciso, Provato e scartato, Attenzione (or their English equivalents).");
  }
  return {
    decided: decided.join("\n").trim(),
    triedAndRuledOut: triedAndRuledOut.join("\n").trim(),
    watchOut: watchOut.join("\n").trim(),
  };
}

function readLesson(id: string, fields: Map<string, string>, body: string[]): ProjectLesson {
  const title = textValue(fields.get("title") ?? "", "title");
  const source = enumValue(fields.get("source") ?? "", SOURCES, "source");
  const declaredStatus = enumValue(fields.get("status") ?? "", STATUSES, "status");
  const from = fields.has("from") ? textValue(fields.get("from")!, "from") : undefined;
  if (title.length > PROJECT_LIMITS.title) throw new Error("Title exceeds " + PROJECT_LIMITS.title + " characters.");
  if (from !== undefined && from.length > PROJECT_LIMITS.shortText) {
    throw new Error("From exceeds " + PROJECT_LIMITS.shortText + " characters.");
  }
  const always = fields.get("always");
  if (always !== "true" && always !== "false") throw new Error("Expected always to be true or false.");
  return {
    id, title, source, ...(from === undefined ? {} : { from }), declaredStatus,
    always: always === "true", touches: readTouches(fields.get("touches") ?? ""),
    approvedByPerson: false, sections: readSections(body),
  };
}

function lessonDirectory(root: string): string {
  let dir = root;
  for (const part of [...PROJECT_STORE_DIR_PARTS, "lessons"]) {
    dir = join(dir, part);
    const info = lstatSync(dir);
    if (info.isSymbolicLink()) throw new Error("Symbolic link in the project lessons directory path: " + part + ".");
    if (!info.isDirectory()) throw new Error("Expected a directory at " + part + ".");
  }
  return dir;
}

function lessonFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = opendirSync(dir);
  try {
    for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
      if (!entry.name.endsWith(".md")) continue;
      files.push(entry.name);
      if (files.length > PROJECT_LIMITS.lessonFiles) {
        throw new Error("Too many lesson files. Limit: " + PROJECT_LIMITS.lessonFiles + ".");
      }
    }
  } finally {
    entries.closeSync();
  }
  return files.sort();
}

function readLessonFile(root: string, dir: string, file: string): string {
  const path = join(dir, file);
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink()) throw new Error("Symbolic link. Expected a regular lesson file.");
  if (!before.isFile()) throw new Error("Expected a regular lesson file.");

  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    lessonDirectory(root);
    const current = lstatSync(path, { bigint: true });
    if (!opened.isFile() || !current.isFile() || opened.ino !== before.ino || opened.dev !== before.dev ||
        opened.ino !== current.ino || opened.dev !== current.dev || realpathSync.native(path) !== path) {
      throw new Error("Lesson file changed during opening or is outside the lesson directory.");
    }

    const limit = PROJECT_LIMITS.lessonFileBytes;
    const tooLarge = "Lesson file exceeds " + limit + " bytes.";
    if (opened.size > limit) throw new Error(tooLarge);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > limit) throw new Error(tooLarge);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

/** Read only this project's lesson files, without consulting config, decisions or memory. */
export function readProjectLessons(folder: string): ProjectLessons {
  const result: ProjectLessons = { lessons: [], problems: [] };
  let root: string;
  let dir: string;
  try {
    const requested = resolve(folder);
    const info = lstatSync(requested);
    if (info.isSymbolicLink()) throw new Error("Symbolic link at the requested project folder.");
    if (!info.isDirectory()) throw new Error("Expected a project folder.");
    root = realpathSync.native(requested);
    dir = lessonDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      result.problems.push({ file: "lessons", reason: (error as Error).message });
    }
    return result;
  }

  let files: string[];
  try {
    files = lessonFiles(dir);
  } catch (error) {
    result.problems.push({ file: "lessons", reason: (error as Error).message });
    return result;
  }

  const ids = new Map<string, number>();
  const entries = files.map((file) => {
    let id: string | undefined;
    try {
      const { fields, body } = frontMatter(readLessonFile(root, dir, file).split(/\r?\n/));
      const declaredId = textValue(fields.get("id") ?? "", "id");
      if (!/^[a-z0-9-]+$/.test(declaredId) || declaredId.length > PROJECT_LIMITS.id) {
        throw new Error("Invalid id. Expected up to " + PROJECT_LIMITS.id + " lowercase letters, digits or hyphens.");
      }
      id = declaredId;
      ids.set(id, (ids.get(id) ?? 0) + 1);
      if (id !== file.slice(0, -3)) throw new Error("The id must match the file name.");
      return { file, id, lesson: readLesson(id, fields, body) };
    } catch (error) {
      return { file, id, reason: (error as Error).message };
    }
  });

  for (const { file, id, lesson, reason } of entries) {
    if (id !== undefined && (ids.get(id) ?? 0) > 1) {
      result.problems.push({ file, reason: "Duplicate id: " + id + "." });
    } else if (lesson !== undefined) {
      result.lessons.push(lesson);
    } else {
      result.problems.push({ file, reason });
    }
  }
  return result;
}
