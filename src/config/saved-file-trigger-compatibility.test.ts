import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../tasks/task-store.js";
import { USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "./config-schema.js";
import { setConfigNoticeSink } from "./config-primitives.js";
import {
  ensureUserConfigFileSync, readUserConfigFileSync, readUserConfigSnapshotSync,
  userConfigFileSha256Sync,
} from "./config-file.js";

let root: string | undefined;
afterEach(() => { setConfigNoticeSink(null); if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

const readers = {
  readUserConfigFileSync,
  readUserConfigSnapshotSync: (path: string) => readUserConfigSnapshotSync(path).config,
  ensureUserConfigFileSync,
};

function fixture(invalidId: string, version = USER_CONFIG_VERSION) {
  root = mkdtempSync(join(tmpdir(), "saved-trigger-"));
  const path = join(root, "config.json");
  const trigger = { path: "~/Inbox", userMessageTemplate: "Process {{path}}" };
  writeFileSync(path, JSON.stringify({ ...USER_CONFIG_DEFAULTS, version, fileTriggers: {
    valid: { ...trigger, sessionId: "codex:Y" }, invalid: { ...trigger, sessionId: invalidId },
    alsoInvalid: { ...trigger, sessionId: "bad\\id" },
  } }));
  const notices: string[] = [];
  setConfigNoticeSink(line => notices.push(line));
  return { path, notices };
}

for (const [name, read] of Object.entries(readers)) {
  it.each(["compaction/Y", "work/inbox"])(`${name} loads the valid trigger and warns once for saved invalid ID %s`, invalidId => {
    const { path, notices } = fixture(invalidId);
    const bytes = readFileSync(path, "utf8");
    const config = read(path)!;
    expect(Object.keys(config.fileTriggers)).toEqual(["valid"]);
    expect(config.fileTriggers.valid).toMatchObject({ enabled: true, sessionId: "codex:Y" });
    const store = new TaskStore({ dbFile: join(root!, "tasks.sqlite") });
    try {
      expect(store.create({ sessionId: config.fileTriggers.valid!.sessionId, userMessage: "synthetic file event", origin: "scheduler", triggerSource: "file", maxAttempts: 1 }).sessionId).toBe("codex:Y");
    } finally { store.close(); }
    read(path);
    expect(notices.filter(line => line.includes("file triggers"))).toHaveLength(1);
    expect(notices.join("\n")).not.toContain(invalidId);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(readUserConfigSnapshotSync(path).sha256).toBe(userConfigFileSha256Sync(path));
  });
}

it("migrates the usable config after discarding only invalid saved trigger sessions", () => {
  const { path, notices } = fixture("compaction/Y", USER_CONFIG_VERSION - 1);
  expect(Object.keys(ensureUserConfigFileSync(path).fileTriggers)).toEqual(["valid"]);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.version).toBe(USER_CONFIG_VERSION);
  expect(Object.keys(saved.fileTriggers)).toEqual(["valid"]);
  expect(notices.filter(line => line.includes("file triggers"))).toHaveLength(1);
});
