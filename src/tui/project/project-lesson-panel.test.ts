import { displayWidth } from "../render/display-width.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Key } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stateDirProjectRecords } from "../../session/project-decisions.js";
import { fixtureProjectGateView } from "../../session/project-gate-view-fixtures.js";
import { ChatOrchestrator } from "../chat-orchestrator.js";
import type { TuiAction } from "../tui-action.js";
import { handleProjectCardKey } from "./project-card-keys.js";
import { projectCardLines } from "./project-card-lines.js";
import { isProjectCardAction, reduceProjectCard } from "./project-card-state.js";

it("counts invisible Unicode formatting characters as zero columns", () => {
  expect(displayWidth("a\u{E0061}\u202E\u2029b")).toBe(2);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function fixture({ incognito = false, busy = false, otherChatBusy = false, autoRead = true, symlink = false } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "aa-lessons-tui-"));
  roots.push(folder);
  const refFolder = symlink ? join(folder, "alias") : folder;
  if (symlink) symlinkSync(folder, refFolder, "junction");
  const stateDir = join(folder, "state");
  const records = stateDirProjectRecords(stateDir);
  expect(records.write(folder, "project", 0, { milestones: [], gate: { kind: "none" } }).ok).toBe(true);
  const directory = join(folder, ".atomic", "project", "lessons");
  mkdirSync(directory, { recursive: true });
  const write = (id: string, status = "active", body = "Keep storage local.", title = "Local storage") =>
    writeFileSync(join(directory, id + ".md"), [
      "---", "id: " + id, "title: " + JSON.stringify(title), "source: " + (status === "proposed" ? "director" : "person"),
      "touches: [src/storage]", "always: true", "status: " + status, "---",
      "## Decided", body, "## Tried and ruled out", "Remote database", "## Watch out", "Test migrations",
    ].join("\n"));
  const record = () => {
    const result = records.read(folder);
    if (!result.ok || !result.record) throw new Error("Missing test project record.");
    return result.record;
  };
  let card = reduceProjectCard(null, { type: "project_card_shown", sessionId: "s1", full: true, view: fixtureProjectGateView({ kind: "plan" }) });
  const dispatch = (action: TuiAction) => {
    if (isProjectCardAction(action)) card = reduceProjectCard(card, action);
  };
  const sendMessage = vi.fn();
  const liveProjectTurn = vi.fn(() => otherChatBusy ? "s2" : null);
  const app = Object.assign(Object.create(ChatOrchestrator.prototype), {
    currentController: busy ? {} : null,
    session: { id: "s1", projectRef: { folder: refFolder, id: "project" }, ...(incognito ? { incognito: { since: 1, owner: "test" } } : {}) },
    runtime: { config: { paths: { stateDir } }, sessionStore: { liveProjectTurn } },
    bus: { emit: dispatch },
    sendMessage,
  }) as ChatOrchestrator;
  const seen = () => {
    const row = card?.lessons?.rows.find(item => item.id === card?.lessonId);
    if (row) dispatch({ type: "project_card_lesson_end_visible", sessionId: "s1", id: row.id, hash: row.hash });
  };
  const press = (input: string, key: Partial<Key> = {}) => {
    handleProjectCardKey(input, key as Key, card!, {
      dispatch,
      callbacks: {
        onApprovalDecision: vi.fn(), onAbort: vi.fn(), onQuit: vi.fn(),
        onProjectLessons: (sessionId, decision) => app.projectLessons(sessionId, decision),
      },
    });
    if (key.return && autoRead) seen();
  };
  const lines = (width = 90) => projectCardLines(card!, width).map(line => line.segments.map(s => s.text).join(""));
  const text = (width?: number) => lines(width).join("\n");
  const detail = () => { press("v"); press("", { return: true }); };
  return { write, directory, record, press, text, lines, detail, sendMessage, liveProjectTurn, seen, refFolder };
}

describe("project lessons in the TUI", () => {
  it("uses the exact bound folder for lesson reads and live-turn checks", () => {
    const f = fixture({ symlink: true });
    f.write("storage");
    f.press("v");
    expect(f.liveProjectTurn).toHaveBeenCalledWith(f.refFolder, "project");
    expect(f.text()).toMatch(/Skipped lessons.*Symbolic link/i);
    expect(f.text()).not.toContain("Local storage");
  });

  it("lists declared and effective states, origin, scope, and skipped files", () => {
    const f = fixture();
    f.write("a-approved");
    f.detail();
    f.press("a");
    f.press("", { escape: true });
    f.press("", { escape: true });
    f.write("b-proposal", "proposed", "Review this.", "Director proposal");
    f.write("c-unapproved");
    writeFileSync(join(f.directory, "invalid.md"), "invalid");
    f.press("v");
    expect(f.text()).toMatch(/a-approved[\s\S]*person[\s\S]*declared: active[\s\S]*effective: approved/);
    expect(f.text()).toMatch(/b-proposal[\s\S]*declared by the director[\s\S]*declared: proposed[\s\S]*effective: proposed/);
    expect(f.text()).toMatch(/c-unapproved[\s\S]*effective: unapproved[\s\S]*always: true[\s\S]*src\/storage/);
    expect(f.text()).toMatch(/Skipped invalid\.md: .+/);
    f.press("", { escape: true });
    f.write("a-approved", "active", "New text");
    f.press("v");
    expect(f.text()).toMatch(/a-approved[\s\S]*effective: stale/);
  });

  it("shows every projected section and wraps long unbroken content without truncating it", () => {
    const f = fixture();
    const body = "X".repeat(290) + "END";
    f.write("storage", "active", body);
    f.detail();
    expect(f.text()).toMatch(/storage@[a-f0-9]{12}/);
    expect(f.lines(40).every(line => line.length <= 40)).toBe(true);
    expect(f.text(40).replace(/\s/g, "")).toContain(body);
    expect(f.text()).toContain("Remote database");
    expect(f.text()).toContain("Test migrations");
  });

  it("marks the 300-character prompt boundary and still shows the unprojected section", () => {
    const f = fixture();
    f.write("storage", "active", "x".repeat(299) + "BEYOND THE PROMPT");
    f.detail();
    expect(f.text()).toMatch(/Model sees only up to here.*300-character limit[\s\S]*BEYOND THE PROMPT/);
  });

  it("marks additional binding truncation from shared prompt space", () => {
    const f = fixture();
    for (let index = 5; index > 0; index--) {
      f.write("approved-" + index);
      f.detail();
      f.press("a");
      f.press("", { escape: true });
      f.press("", { escape: true });
    }
    f.write("a-binding", "active", "x".repeat(299) + "END");
    const file = join(f.directory, "a-binding.md");
    const paths = Array.from({ length: 14 }, (_, index) => "src/" + "x".repeat(1015) + index);
    writeFileSync(file, readFileSync(file, "utf8").replace("src/storage", paths.join(", ")));
    f.detail();
    expect(f.text()).toMatch(/Model sees only up to here.*shared planning budget/);
    expect(f.text()).toContain("300-character limit");
  });

  it("blocks approval until the current detail end has been visible", () => {
    const f = fixture({ autoRead: false });
    f.write("storage", "active", "Review this. ".repeat(80));
    f.detail();
    expect(f.text()).not.toContain("a Approve");
    f.press("a");
    expect(f.record().lessonCalls?.storage).toBeUndefined();
    f.seen();
    expect(f.text()).toContain("a Approve");
    f.press("a");
    expect(f.record().lessonCalls?.storage?.state).toBe("approved");
  });

  it("approves the reviewed fingerprint, retires it and reopens it without starting a turn", () => {
    const f = fixture();
    f.write("storage");
    f.detail();
    const fingerprint = f.text().match(/storage@([a-f0-9]{12})/)?.[1];
    expect(fingerprint).toBeDefined();
    f.press("a");
    const approved = f.record().lessonCalls?.storage;
    expect(approved).toEqual({ state: "approved", hash: expect.stringMatching(new RegExp("^" + fingerprint + "[a-f0-9]{52}$")), always: true });
    f.press("t");
    expect(f.record().lessonCalls?.storage).toEqual({ ...approved, state: "retired" });
    f.press("r");
    expect(f.record().lessonCalls?.storage).toBeUndefined();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["deleted", "invalid"])("reopens a recorded choice for a %s lesson", (change) => {
    const f = fixture();
    f.write("storage");
    f.detail();
    f.press("a");
    const hash = f.record().lessonCalls?.storage?.hash;
    expect(hash).toBeDefined();
    const file = join(f.directory, "storage.md");
    if (change === "deleted") rmSync(file);
    else writeFileSync(file, "invalid");
    f.press("f");
    expect(f.text()).toMatch(/storage.*missing or invalid/i);
    f.press("", { return: true });
    expect(f.text()).toContain("storage@" + hash!.slice(0, 12));
    expect(f.text()).toContain("r Reopen");
    expect(f.text()).not.toMatch(/a Approve|t Retire/);
    f.press("r");
    expect(f.record().lessonCalls?.storage).toBeUndefined();
  });

  it("rejects an edited file and reloads before a new approval", () => {
    const f = fixture();
    f.write("storage");
    f.detail();
    f.write("storage", "active", "Updated lesson");
    f.press("a");
    expect(f.text()).toMatch(/lesson has changed.*read it again/i);
    expect(f.record().lessonCalls?.storage).toBeUndefined();
    f.press("a");
    expect(f.record().lessonCalls?.storage).toBeUndefined();
    f.press("", { return: true });
    expect(f.text()).toContain("Updated lesson");
    f.press("a");
    expect(f.record().lessonCalls?.storage?.state).toBe("approved");
  });

  it("shows how to activate a proposal and offers no approval", () => {
    const f = fixture();
    f.write("storage", "proposed");
    f.detail();
    expect(f.text()).toMatch(/status: active[\s\S]*final text/);
    expect(f.text()).not.toContain("a Approve");
    f.press("a");
    expect(f.record().lessonCalls?.storage).toBeUndefined();
  });

  it.each([
    [{ busy: true }, /turn is running/i],
    [{ otherChatBusy: true }, /turn is running/i],
    [{ incognito: true }, /incognito/i],
  ] as const)("disables actions when access is unavailable (%j)", (options, reason) => {
    const f = fixture(options);
    f.write("storage");
    f.detail();
    expect(f.text()).toMatch(reason);
    expect(f.text()).not.toContain("a Approve");
    f.press("a");
    f.press("t");
    f.press("r");
    expect(f.record().lessonCalls?.storage).toBeUndefined();
  });

  it("rechecks live turns when a decision is made from an already open detail", () => {
    const f = fixture();
    f.write("storage");
    f.detail();
    expect(f.text()).toContain("a Approve");

    f.liveProjectTurn.mockReturnValue("s2");
    f.press("a");
    expect(f.text()).toMatch(/turn is running/i);
    expect(f.text()).not.toContain("a Approve");
    expect(f.record().lessonCalls?.storage).toBeUndefined();

    f.liveProjectTurn.mockReturnValue(null);
    f.press("f");
    f.press("a");
    expect(f.record().lessonCalls?.storage?.state).toBe("approved");
  });

  it("refuses decisions from an agent tool process", () => {
    vi.stubEnv("ATOMIC_AGENT_TOOL_CHILD", "1");
    const f = fixture();
    f.write("storage");
    f.detail();
    expect(f.text(120)).toMatch(/outside an agent tool process/i);
    f.press("a");
    expect(f.record().lessonCalls?.storage).toBeUndefined();
  });

  it.each([["\u{E0061}", "E0061"], ["\u202E", "202E"]])("skips invisible text in the lesson panel (%s)", (character, code) => {
    const f = fixture();
    f.write("storage", "active", "Inert " + character + " text");
    f.press("v");
    expect(f.text()).toContain("Skipped storage.md");
    expect(f.text()).toContain("U+" + code);
    expect(f.text()).not.toContain(character);
  });

  it("neutralizes terminal control characters in every author field shown", () => {
    const f = fixture();
    f.write("storage", "active", "before\x1b]52;c;AAAA\x07after\x9b2J");
    if (process.platform !== "win32") {
      writeFileSync(join(f.directory, "invalid\x1b[2J.md"), "invalid");
      f.press("v");
      expect(f.text()).toContain("Skipped invalid\\u001b[2J.md");
      expect(f.text()).not.toContain("\x1b");
      f.press("", { escape: true });
    }
    f.detail();
    expect(f.text()).toContain("after");
    expect(f.text()).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  });
});
