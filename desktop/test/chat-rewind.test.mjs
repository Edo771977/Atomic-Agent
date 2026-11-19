// ATO-1056 / ATO-1058: Roll back here, Edit and Fork from here on a message.
// main/chat-rewind.ts is checked against the built output (npm run build
// first); the pure half of renderer/chat-rewind.js is loaded as a CommonJS
// module; the wiring is read from the sources.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/chat-rewind.js");
const R = require("../renderer/chat-rewind.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ---------- main: what may be sent, and the answer ---------- */

test("the window may send only a whole non-negative position and a question's text", () => {
  assert.deepEqual(M.rewindRequestBody(2, "fix it"), { priorQuestions: 2, expectText: "fix it" });
  assert.equal(M.rewindRequestBody(-1, "x"), null);
  assert.equal(M.rewindRequestBody(1.5, "x"), null);
  assert.equal(M.rewindRequestBody("1", "x"), null);
  assert.equal(M.rewindRequestBody(0, "  "), null);
  assert.equal(M.rewindRequestBody(0, 7), null);
});

test("the agent's answers read as ok, refusal, unknown chat or an agent without the routes", () => {
  assert.deepEqual(M.rewindAnswer(200, { id: "s-1", files: [] }), { ok: true, supported: true, data: { id: "s-1", files: [] } });
  assert.deepEqual(M.rewindAnswer(409, { error: { message: "busy", code: "turn_in_progress" } }), {
    ok: false, supported: true, code: "turn_in_progress", error: "busy",
  });
  assert.equal(M.rewindAnswer(404, { error: { message: "session not found: s-1", code: "session_not_found" } }).code, "session_not_found");
  assert.equal(M.rewindAnswer(404, { error: { message: "no route" } }).supported, false);
  assert.equal(M.rewindAnswer(500, null).error, "HTTP 500");
});

/* ---------- renderer: which question, and what the confirmation says ---------- */

test("a reply stands for the question it answers; a steer stands for none", () => {
  const q0 = { id: "u0", k: "user", text: "first" };
  const a0 = { id: "a0", k: "assistant", text: "one" };
  const q1 = { id: "u1", k: "user", text: "second" };
  const steer = { id: "u2", k: "user", text: "and this", steered: true };
  const a1 = { id: "a1", k: "assistant", text: "two" };
  const log = [q0, a0, q1, steer, a1];
  assert.equal(R.rewindQuestionFor(log, q1), q1);
  assert.equal(R.rewindQuestionFor(log, a0), q0);
  assert.equal(R.rewindQuestionFor(log, a1), q1);
  assert.equal(R.rewindQuestionFor(log, steer), null);
  assert.equal(R.rewindQuestionFor([a0], a0), null);
  assert.equal(R.rewindQuestionFor(log, { id: "t", k: "tool" }), null);
});

test("the confirmation lists the files that change, the ones that cannot, and what is never undone", () => {
  const s = R.rewindSummary({
    removed: { questions: 2, replies: 1 },
    files: [
      { path: "/w/app/src/a.ts", action: "restore" },
      { path: "/w/app/new.txt", action: "delete" },
      { path: "/elsewhere/b.md", action: "restore" },
    ],
    notRestorable: [{ path: "/w/app/photo.png", reason: "binary" }],
    incomplete: true,
    uncovered: [{ tool: "os.shell.run", count: 2 }, { tool: "os.git.commit", count: 1 }, { tool: "os.fs.write", count: 4 }],
  }, "/w/app/");
  assert.equal(s.removedText, "2 messages of yours and 1 reply will be removed from this chat.");
  assert.deepEqual(s.restore, ["src/a.ts", "/elsewhere/b.md"]);
  assert.deepEqual(s.remove, ["new.txt"]);
  assert.deepEqual(s.cannot, ["photo.png (not a text file)"]);
  assert.match(s.warnings[0], /no longer kept/);
  assert.equal(s.warnings[1], "This part of the chat also ran 2 shell commands, 1 git command. What they changed is not undone.");
  assert.match(s.warnings.at(-1), /Shell commands and Fusion workers are never undone/);
});

test("an empty preview still says what goes and that shell changes stay", () => {
  const s = R.rewindSummary({ removed: { questions: 1, replies: 1 }, files: [], notRestorable: [], uncovered: [] }, "");
  assert.equal(s.removedText, "1 message of yours and 1 reply will be removed from this chat.");
  assert.deepEqual([s.restore, s.remove, s.cannot], [[], [], []]);
  assert.equal(s.warnings.length, 1);
});

test("refusals are worded, unknown ones keep the agent's message", () => {
  assert.match(R.rewindRefusalText({ code: "turn_in_progress" }), /still working/);
  assert.match(R.rewindRefusalText({ code: "point_mismatch" }), /changed on the agent side/);
  assert.equal(R.rewindRefusalText({ error: "disk full" }), "disk full");
});

/* ---------- Edit: the same confirmation, files and conversation or the conversation only ---------- */

const FILES_PREVIEW = {
  removed: { questions: 1, replies: 1 },
  files: [{ path: "/w/src/a.ts", action: "restore" }, { path: "/w/new.txt", action: "delete" }],
  notRestorable: [],
  uncovered: [],
};
const NO_FILES_PREVIEW = { removed: { questions: 1, replies: 1 }, files: [], notRestorable: [], uncovered: [] };

/** The renderer globals chat-rewind.js reads at call time, recording what reaches the agent. */
function fakeWindow(calls) {
  const g = globalThis;
  g.S = { overlay: "rewind", agentSession: "s-1", draft: "", log: [] };
  g.BR = {
    rewind: async (...args) => { calls.push(["rewind", ...args]); return { ok: true, supported: true, data: { restored: [], deleted: [], failed: [] } }; },
  };
  g.openSession = async (sid) => { calls.push(["open", sid]); };
  g.submit = () => { calls.push(["submit", g.S.draft]); };
  g.document = { getElementById: (id) => (id === "rw-edit" ? { value: "fixed text" } : null) };
  g.$ = () => null;
  g.render = () => {};
  g.toast = () => {};
  g.refreshSend = () => {};
  g.autosize = () => {};
  g.attToEditor = (t) => t;
  g.esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.ic = () => "";
  g.sheet = (title, body, foot) => `<h>${title}</h><b>${body}</b><f>${foot}</f>`;
  g.WORKSPACE = "/w";
}

function startEdit(preview) {
  Object.assign(R.REWIND, { mode: "edit", id: "u1", sid: "s-1", prior: 1, text: "old text", preview, loading: false, busy: false, error: null, partial: null, partialCode: null, skip: [], afterPartial: false, draft: "old text" });
}

const footActs = (html) => [...html.split("<f>")[1].matchAll(/data-act="(rewind:[^"]+)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]);

test("Edit on a message with changed files lists them and offers both ways", () => {
  fakeWindow([]);
  startEdit(FILES_PREVIEW);
  const html = R.rewindSheetHTML();
  assert.match(html, /id="rw-edit"/);
  assert.match(html, /Put back as they were/);
  assert.match(html, /src\/a\.ts/);
  assert.match(html, /Removed \(the agent created them\)/);
  assert.match(html, /new\.txt/);
  assert.deepEqual(footActs(html), [
    ["rewind:go-chat", "Conversation only"],
    ["rewind:go", "Roll back files and conversation, then resend"],
  ]);
});

for (const [act, files] of [["go", true], ["go-chat", false]]) {
  test(`Edit's ${act} button rolls back with files: ${files} before it resends`, async () => {
    const calls = [];
    fakeWindow(calls);
    startEdit(FILES_PREVIEW);
    await R.rewindAct(act);
    assert.deepEqual(calls, [["rewind", "s-1", 1, "old text", files], ["open", "s-1"], ["submit", "fixed text"]]);
  });
}

test("Edit with no file changes has no file section and one button, conversation only", async () => {
  const calls = [];
  fakeWindow(calls);
  startEdit(NO_FILES_PREVIEW);
  const html = R.rewindSheetHTML();
  assert.doesNotMatch(html, /Put back as they were|Removed \(the agent|Cannot be put back|No files will change|file tools/);
  assert.match(html, /1 message of yours and 1 reply will be removed/);
  assert.deepEqual(footActs(html), [["rewind:go-chat", "Send edited message"]]);
  await R.rewindAct("go-chat");
  assert.deepEqual(calls[0], ["rewind", "s-1", 1, "old text", false]);
  assert.deepEqual(calls.at(-1), ["submit", "fixed text"]);
});

test("Roll back here keeps one button and leaves the files flag to the agent", async () => {
  const calls = [];
  fakeWindow(calls);
  startEdit(FILES_PREVIEW);
  R.REWIND.mode = "back";
  assert.deepEqual(footActs(R.rewindSheetHTML()), [["rewind:go", "Roll back"]]);
  await R.rewindAct("go");
  assert.deepEqual(calls, [["rewind", "s-1", 1, "old text", undefined], ["open", "s-1"]]);
});

test("only a rollback passes the files flag on to the agent", () => {
  assert.deepEqual(M.rewindRequestBody(0, "x", false), { priorQuestions: 0, expectText: "x", files: false });
  assert.deepEqual(M.rewindRequestBody(0, "x", true), { priorQuestions: 0, expectText: "x", files: true });
  assert.deepEqual(M.rewindRequestBody(0, "x", "no"), { priorQuestions: 0, expectText: "x" });
  assert.match(src("../main/chat-rewind-ipc.ts"), /route === "rewind" \? files : undefined/);
  assert.match(src("../preload/preload.ts"), /"agent:rewind", \{ sessionId, priorQuestions, expectText, files(, skip(, acceptFailed)?)? \}/);
});

/* ---------- wiring ---------- */

test("the actions are drawn on messages, routed through act() and the overlay, and reach the agent through main", () => {
  const renderer = src("../renderer/renderer.js");
  assert.match(renderer, /rewindActsHTML\(m\)/);
  assert.match(renderer, /S\.overlay === 'rewind'\) html \+= rewindSheetHTML\(\)/);
  assert.match(renderer, /k === 'rewind'\) \{ rewindAct\(/);
  // The copy/retry probes leave the new buttons out, so their pinned orders hold.
  assert.match(renderer, /filter\(\(b\) => !b\.dataset\.rw\)/);
  assert.match(src("../renderer/index.html"), /<script src="chat-rewind.js"><\/script>\s*\n(?:.*\n)*<script src="renderer.js"><\/script>/);
  const preload = src("../preload/preload.ts");
  for (const ch of ["agent:rewindPreview", "agent:rewind", "agent:forkSession"]) assert.ok(preload.includes(`"${ch}"`), ch);
  const ipc = src("../main/chat-rewind-ipc.ts");
  for (const route of ['"rewind/preview"', '"rewind"', '"fork"']) assert.ok(ipc.includes(route), route);
  assert.match(src("../main/main.ts"), /wireChatRewindIpc\(client\)/);
});

/* ---------- issue #77: a rollback that could put back only some files ---------- */

const PARTIAL_MESSAGE = "some files could not be put back (see failed); the chat was not cut and the saved copies were kept, so the rollback can be tried again";
const partialBody = (failed, extra = {}) => ({
  error: { code: "restore_failed", message: PARTIAL_MESSAGE },
  // The agent's shape (applyFileRestore): restored and deleted are path strings, failed is {path, error}.
  restored: ["/w/src/a.ts", "/w/src/b.ts"],
  deleted: ["/w/new.txt"],
  failed,
  ...extra,
});

test("a partial restore (409 restore_failed) carries what was put back and what was not, checked and capped", () => {
  const failed = [{ path: "/w/locked.txt", error: "EACCES: permission denied" }, { path: "/w/gone/x.ts" }, { path: 7 }, null, { path: "" }, { path: "/w/y", error: 3 }];
  const a = M.rewindAnswer(409, partialBody(failed));
  assert.equal(a.ok, false);
  assert.equal(a.code, "restore_failed");
  assert.deepEqual(JSON.parse(JSON.stringify(a.restore)), {
    restored: ["/w/src/a.ts", "/w/src/b.ts"], deleted: ["/w/new.txt"],
    failed: [{ path: "/w/locked.txt", error: "EACCES: permission denied" }, { path: "/w/gone/x.ts" }, { path: "/w/y" }],
    restoredTotal: 2, deletedTotal: 1, failedTotal: 3,
  });
  // A {path} entry reads too, and entries that are neither are dropped.
  const mixed = M.rewindAnswer(409, partialBody([], { restored: ["/w/a", { path: "/w/b" }, 5, ""], deleted: [{ path: "/w/c" }] }));
  assert.deepEqual([...mixed.restore.restored], ["/w/a", "/w/b"]);
  assert.deepEqual([mixed.restore.restoredTotal, mixed.restore.deletedTotal], [2, 1]);
  const many = M.rewindAnswer(409, partialBody(Array.from({ length: 500 }, (_, i) => ({ path: `/w/f${i}` }))));
  // Every failed path is kept (up to the skip cap), so all of them can be left alone (issue #80).
  assert.equal(many.restore.failed.length, 500);
  assert.equal(many.restore.failedTotal, 500);
  const huge = M.rewindAnswer(409, partialBody(Array.from({ length: 1500 }, (_, i) => ({ path: `/w/f${i}` }))));
  assert.equal(huge.restore.failed.length, 1000);
  // Another refusal carries them too when files were changed (see below); a body without arrays still reads as restore_failed.
  assert.equal(M.rewindAnswer(409, { error: { code: "turn_in_progress", message: "busy" } }).restore, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(M.rewindAnswer(409, { error: { code: "restore_failed", message: "x" }, failed: "no" }).restore)),
    { restored: [], deleted: [], failed: [], restoredTotal: 0, deletedTotal: 0, failedTotal: 0 });
});

for (const mode of ["back", "edit"]) {
  test(`a partial restore keeps the ${mode} sheet open and says which files, that the chat stayed, and to press again`, async () => {
    const calls = [];
    fakeWindow(calls);
    const failed = [{ path: "/w/locked.txt", error: "EACCES: permission denied" }, ...Array.from({ length: 11 }, (_, i) => ({ path: `/w/f${i}.txt` }))];
    globalThis.BR.rewind = async (...args) => { calls.push(["rewind", ...args]); return M.rewindAnswer(409, partialBody(failed)); };
    startEdit(FILES_PREVIEW);
    R.REWIND.mode = mode;
    await R.rewindAct("go");
    assert.deepEqual(calls.map((c) => c[0]), ["rewind"], "the chat was opened or resent after a partial restore");
    assert.equal(globalThis.S.overlay, "rewind");
    const html = R.rewindSheetHTML();
    assert.doesNotMatch(html, /see failed/);
    assert.match(html, /could not be put back/i);
    assert.match(html, /locked\.txt/);
    assert.match(html, /permission denied/);
    assert.doesNotMatch(html, /\/w\/locked/, "paths read from the working folder");
    assert.match(html, /f6\.txt/);
    assert.doesNotMatch(html, /f7\.txt/);
    assert.match(html, /and 4 more/);
    assert.match(html, /chat was left as it was/);
    assert.match(html, /3 files already put back stay put back/);
    // Issue #80: trying again checks again first (a fresh preview), so the old one is never re-sent.
    assert.ok(html.includes("Press “Check again”"), html);
    if (mode === "edit") {
      // Conversation only would cut the chat and drop the saved copies: the files not put back would be lost for good.
      assert.deepEqual(footActs(html), [["rewind:recheck", "Check again"]]);
      await R.rewindAct("go-chat");
      assert.deepEqual(calls.map((c) => c[0]), ["rewind"], "Conversation only ran after a partial restore");
    }
    // Checking again starts clean.
    globalThis.BR.rewindPreview = async () => ({ ok: true, supported: true, data: FILES_PREVIEW });
    await R.rewindAct("recheck");
    assert.doesNotMatch(R.rewindSheetHTML(), /locked\.txt/);
  });
}

// Issue #77 review: another refusal (the chat changed, a turn started) can come after files were put back.
test("a refusal after files were put back says which files changed and that the chat was not rolled back", async () => {
  const body = (code, extra) => ({ error: { code, message: "refused" }, ...extra });
  const a = M.rewindAnswer(409, body("point_mismatch", { restored: ["/w/src/a.ts"], deleted: ["/w/new.txt"], failed: [{ path: "/w/l.txt", error: "EBUSY" }] }));
  assert.equal(a.code, "point_mismatch");
  assert.deepEqual(JSON.parse(JSON.stringify(a.restore)), {
    restored: ["/w/src/a.ts"], deleted: ["/w/new.txt"], failed: [{ path: "/w/l.txt", error: "EBUSY" }],
    restoredTotal: 1, deletedTotal: 1, failedTotal: 1,
  });
  // No lists, or empty ones: nothing was changed, so nothing is carried.
  assert.equal(M.rewindAnswer(409, body("turn_in_progress", {})).restore, undefined);
  assert.equal(M.rewindAnswer(409, body("turn_in_progress", { restored: [], deleted: [], failed: [] })).restore, undefined);
  const calls = [];
  fakeWindow(calls);
  globalThis.BR.rewind = async () => M.rewindAnswer(409, body("turn_in_progress", { restored: ["/w/src/a.ts"], deleted: ["/w/new.txt"], failed: [] }));
  startEdit(FILES_PREVIEW);
  R.REWIND.mode = "back";
  await R.rewindAct("go");
  const html = R.rewindSheetHTML();
  assert.match(html, /still working/);
  assert.match(html, /already put back/);
  assert.match(html, /the chat was not rolled back/);
  const changed = html.split("already put back")[1];
  assert.match(changed, /src\/a\.ts/);
  assert.match(changed, /new\.txt/);
  assert.doesNotMatch(html, /could not be put back/);
  assert.doesNotMatch(html, /again to try the rest/);
});

/* ---------- issues #77 / #80: after a partial restore, Continue (skip) and Retry (Check again) ---------- */

test("skip is sent only as a list of at most 1000 paths, only for a rollback; acceptFailed only as a boolean", () => {
  assert.deepEqual(M.rewindRequestBody(0, "x", undefined, undefined, true), { priorQuestions: 0, expectText: "x", acceptFailed: true });
  assert.deepEqual(M.rewindRequestBody(0, "x", undefined, undefined, "yes"), { priorQuestions: 0, expectText: "x" });
  assert.deepEqual(M.rewindRequestBody(0, "x", undefined, ["/w/a", "/w/b"]), { priorQuestions: 0, expectText: "x", skip: ["/w/a", "/w/b"] });
  assert.deepEqual(M.rewindRequestBody(0, "x", true, ["/w/a"]), { priorQuestions: 0, expectText: "x", files: true, skip: ["/w/a"] });
  assert.deepEqual(M.rewindRequestBody(0, "x", undefined, []), { priorQuestions: 0, expectText: "x" });
  for (const bad of ["/w/a", [1], [""], ["/w/a", null], Array.from({ length: 1001 }, (_, i) => `/w/${i}`), true]) {
    assert.equal(M.rewindRequestBody(0, "x", undefined, bad), null, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(M.rewindRequestBody(0, "x", undefined, Array.from({ length: 1000 }, (_, i) => `/w/${i}`)).skip.length, 1000);
  const ipc = src("../main/chat-rewind-ipc.ts");
  assert.match(ipc, /route === "rewind" \? skip : undefined/);
  assert.match(src("../preload/preload.ts"), /"agent:rewind", \{ sessionId, priorQuestions, expectText, files, skip(, acceptFailed)? \}/);
});

/** The fixture every button starts from: a rollback the agent answered with two files not put back. */
const FIRST_FAILED = [{ path: "/w/locked.txt", error: "EBUSY" }, { path: "/w/dir/a.txt", error: "EISDIR" }];

/**
 * A window whose BR answers like the agent: each rewind call goes through
 * preload's argument order and main's rewindRequestBody, and the body the
 * agent would get is recorded with the answer it gives.
 */
function agentWindow(mode, answers) {
  const calls = [];
  fakeWindow(calls);
  const g = globalThis;
  g.BR.rewind = async (sid, priorQuestions, expectText, files, skip) => {
    const body = M.rewindRequestBody(priorQuestions, expectText, files, skip);
    calls.push(["rewind", JSON.parse(JSON.stringify(body))]);
    const next = answers.rewind.shift();
    return M.rewindAnswer(next.status, next.body);
  };
  g.BR.rewindPreview = async () => { calls.push(["preview"]); return { ok: true, supported: true, data: answers.preview.shift() }; };
  g.toasts = [];
  g.toast = (...a) => g.toasts.push(a);
  startEdit(FILES_PREVIEW);
  R.REWIND.mode = mode;
  return calls;
}
const sentBodies = (calls) => calls.filter((c) => c[0] === "rewind").map((c) => c[1]);

for (const [mode, label, files] of [["back", "Roll back without these files", undefined], ["edit", "Roll back without these files, then resend", true]]) {
  test(`${mode}: Continue sends skip with exactly the listed paths, never acceptFailed, and does not loop`, async () => {
    const calls = agentWindow(mode, { rewind: [
      { status: 409, body: partialBody(FIRST_FAILED, { partial: true, skipped: [] }) },
      // Another file failed this time: the notice comes back with it.
      { status: 409, body: partialBody([{ path: "/w/late.txt", error: "EACCES" }], { partial: true, skipped: ["/w/locked.txt", "/w/dir/a.txt"] }) },
      { status: 200, body: { restored: ["/w/src/a.ts"], deleted: [], failed: [], skipped: ["/w/locked.txt", "/w/dir/a.txt", "/w/late.txt"] } },
    ] });
    await R.rewindAct("go");
    const html = R.rewindSheetHTML();
    const button = html.match(/<button[^>]*data-act="rewind:go-skip"[^>]*>([^<]*)</);
    assert.ok(button, "no Continue button after a partial restore");
    assert.equal(button[1], label);
    await R.rewindAct("go-skip");
    const files0 = files === undefined ? {} : { files };
    assert.deepEqual(sentBodies(calls), [
      { priorQuestions: 1, expectText: "old text", ...files0 },
      { priorQuestions: 1, expectText: "old text", ...files0, skip: ["/w/locked.txt", "/w/dir/a.txt"] },
    ]);
    assert.equal(globalThis.S.overlay, "rewind", "the sheet closed on a second partial restore");
    const again = R.rewindSheetHTML();
    assert.match(again, /late\.txt/);
    // Continue once more: the files already left alone stay in the list sent.
    await R.rewindAct("go-skip");
    assert.deepEqual(sentBodies(calls)[2].skip, ["/w/locked.txt", "/w/dir/a.txt", "/w/late.txt"]);
    assert.ok(sentBodies(calls).every((b) => !("acceptFailed" in b)));
    assert.deepEqual(calls.filter((c) => c[0] !== "rewind").map((c) => c[0]), mode === "edit" ? ["open", "submit"] : ["open"]);
  });
}

test("no way out is offered for another refusal, or when nothing failed", async () => {
  const calls = [];
  fakeWindow(calls);
  globalThis.BR.rewind = async () => M.rewindAnswer(409, { error: { code: "point_mismatch", message: "x" }, restored: ["/w/a"], failed: [{ path: "/w/b", error: "E" }] });
  startEdit(FILES_PREVIEW);
  R.REWIND.mode = "back";
  await R.rewindAct("go");
  assert.doesNotMatch(R.rewindSheetHTML(), /go-skip/);
  // Without a partial restore on the sheet the verb sends nothing.
  R.REWIND.partial = null;
  globalThis.BR.rewind = async (...args) => { calls.push(["rewind", ...args]); return { ok: true, supported: true, data: {} }; };
  await R.rewindAct("go-skip");
  assert.deepEqual(calls, []);
});

// Issue #80: Retry after a partial restore re-sent the rollback planned from the old preview, so the
// person was never shown what would be overwritten now (a file they edited since, say).
const FRESH_PREVIEW = {
  removed: { questions: 1, replies: 1 },
  files: [{ path: "/w/src/a.ts", action: "restore" }, { path: "/w/notes-edited-since.md", action: "restore" }],
  notRestorable: [],
  uncovered: [],
};
for (const [mode, confirm] of [["back", "Roll back"], ["edit", "Roll back files and conversation, then resend"]]) {
  test(`${mode}: Retry fetches a fresh preview and shows it before the person confirms`, async () => {
    const calls = agentWindow(mode, {
      rewind: [
        { status: 409, body: partialBody(FIRST_FAILED, { partial: true, skipped: [] }) },
        { status: 200, body: { restored: ["/w/src/a.ts", "/w/notes-edited-since.md"], deleted: [], failed: [] } },
      ],
      preview: [FRESH_PREVIEW],
    });
    await R.rewindAct("go");
    let html = R.rewindSheetHTML();
    // The primary button checks again; it does not roll back with the old preview.
    assert.deepEqual(footActs(html).at(-1), ["rewind:recheck", "Check again"]);
    assert.match(html, /Press “Check again”/);
    await R.rewindAct("go");
    assert.deepEqual(calls.map((c) => c[0]), ["rewind"], "Retry re-sent with the stale preview");
    await R.rewindAct("recheck");
    assert.deepEqual(calls.map((c) => c[0]), ["rewind", "preview"]);
    html = R.rewindSheetHTML();
    assert.match(html, /notes-edited-since\.md/, "the fresh preview is not shown");
    assert.doesNotMatch(html, /could not be put back/);
    assert.equal(footActs(html).at(-1)[1], confirm);
    assert.equal(globalThis.S.overlay, "rewind");
    // Only now does the person confirm, with a plain rollback.
    await R.rewindAct("go");
    const bodies = sentBodies(calls);
    assert.equal(bodies.length, 2);
    assert.ok(!("skip" in bodies[1]) && !("acceptFailed" in bodies[1]));
    assert.deepEqual(calls.map((c) => c[0]).slice(0, 3), ["rewind", "preview", "rewind"]);
  });
}

// Issue #80: the toast after Continue names the files the agent left as they are.
test("after Continue the toast names the files the agent left as they are", async () => {
  agentWindow("back", { rewind: [
    { status: 409, body: partialBody(FIRST_FAILED, { partial: true, skipped: [] }) },
    { status: 200, body: { restored: ["/w/src/a.ts"], deleted: [], failed: [], skipped: ["/w/locked.txt", "/w/dir/a.txt"] } },
  ] });
  await R.rewindAct("go");
  await R.rewindAct("go-skip");
  const [title, text] = globalThis.toasts.at(-1);
  assert.equal(title, "Rolled back");
  assert.match(text, /1 file put back/);
  assert.match(text, /Left as they are: locked\.txt, dir\/a\.txt/);
});

// Issue #80: an older agent ignores `skip` and may plan every file again; the window cannot tell, so it
// promises no more than the agent confirms.
test("the notice asks the agent to leave the files alone, and a 200 without skipped says it was not confirmed", async () => {
  agentWindow("back", { rewind: [
    { status: 409, body: partialBody(FIRST_FAILED, { partial: true, skipped: [] }) },
    { status: 200, body: { restored: ["/w/src/a.ts", "/w/locked.txt"], deleted: [], failed: [] } },
  ] });
  await R.rewindAct("go");
  const html = R.rewindSheetHTML();
  assert.doesNotMatch(html, /stay as they are now/);
  assert.match(html, /asks the agent to leave the files listed above as they are/);
  await R.rewindAct("go-skip");
  const [, text, kind] = globalThis.toasts.at(-1);
  assert.match(text, /your agent did not confirm it left those files alone/);
  assert.equal(kind, "bad");
  // A plain rollback that sent no skip says nothing of the kind.
  agentWindow("back", { rewind: [{ status: 200, body: { restored: ["/w/src/a.ts"], deleted: [], failed: [] } }] });
  await R.rewindAct("go");
  assert.doesNotMatch(globalThis.toasts.at(-1)[1], /did not confirm/);
});

/* ---------- issue #80 review: the window driven through main's real agent:rewind handler ---------- */

const ipcRequire = createRequire(import.meta.url);
/**
 * A window whose BR is preload's: each call is the object preload sends,
 * handled by main's wireChatRewindIpc (electron's ipcMain stubbed), whose
 * client answers like the agent. Records the route and body the agent gets.
 */
function ipcWindow(mode, answers) {
  const calls = [];
  fakeWindow(calls);
  const g = globalThis;
  const handlers = {};
  const electron = ipcRequire.resolve("electron");
  const saved = ipcRequire.cache[electron];
  ipcRequire.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } } };
  try {
    delete ipcRequire.cache[ipcRequire.resolve("../out/main/chat-rewind-ipc.js")];
    ipcRequire("../out/main/chat-rewind-ipc.js").wireChatRewindIpc({
      sessionRoute: async (sid, route, method, body) => {
        calls.push([route, JSON.parse(JSON.stringify(body))]);
        const next = (route === "rewind/preview" ? answers.preview : answers.rewind).shift();
        if (next instanceof Error) throw next;
        return next;
      },
    });
  } finally {
    if (saved) ipcRequire.cache[electron] = saved; else delete ipcRequire.cache[electron];
  }
  g.BR.rewind = (sessionId, priorQuestions, expectText, files, skip, acceptFailed) =>
    handlers["agent:rewind"]({}, { sessionId, priorQuestions, expectText, files, skip, acceptFailed });
  g.BR.rewindPreview = (sessionId, priorQuestions, expectText) => handlers["agent:rewindPreview"]({}, { sessionId, priorQuestions, expectText });
  g.toasts = [];
  g.toast = (...a) => g.toasts.push(a);
  startEdit(FILES_PREVIEW);
  R.REWIND.mode = mode;
  return calls;
}
const agentBodies = (calls) => calls.filter((c) => c[0] === "rewind").map((c) => c[1]);
const PARTIAL_409 = (failed, extra = {}) => ({ status: 409, body: partialBody(failed, { partial: true, skipped: [], ...extra }) });

for (const [label, second] of [
  ["a turn started", { status: 409, body: { error: { code: "turn_in_progress", message: "busy" } } }],
  ["the request failed", new Error("socket hang up")],
]) {
  for (const mode of ["back", "edit"]) {
    test(`${mode}: after Continue, a refusal that is not partial (${label}) keeps Check again only, and nothing plain is sent`, async () => {
      const calls = ipcWindow(mode, { rewind: [PARTIAL_409(FIRST_FAILED), second], preview: [{ status: 200, body: FILES_PREVIEW }] });
      await R.rewindAct("go");
      await R.rewindAct("go-skip");
      assert.equal(agentBodies(calls).length, 2);
      assert.deepEqual(agentBodies(calls)[1].skip, ["/w/locked.txt", "/w/dir/a.txt"]);
      const html = R.rewindSheetHTML();
      assert.deepEqual(footActs(html), [["rewind:recheck", "Check again"]], "the stale Roll back came back");
      await R.rewindAct("go");
      await R.rewindAct("go-chat");
      assert.equal(agentBodies(calls).length, 2, "a plain rollback was sent with the stale preview");
      await R.rewindAct("recheck");
      assert.equal(calls.at(-1)[0], "rewind/preview");
    });
  }
}

// Issue #80 review: a skip list the window cannot send in full (over the cap, or failed paths the
// answer did not list) must not be offered as "leave these files alone".
test("Continue is not offered when the files to leave alone are more than can be named", async () => {
  const many = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ path: `/w/f${from + i}` }));
  assert.equal(R.REWIND_SKIP_CAP, M.REWIND_SKIP_CAP);
  // More failed than the answer lists.
  let calls = ipcWindow("back", { rewind: [PARTIAL_409(many(1500))] });
  await R.rewindAct("go");
  let html = R.rewindSheetHTML();
  assert.doesNotMatch(html, /rewind:go-skip/);
  assert.match(html, /Too many files could not be put back to leave each one alone/);
  await R.rewindAct("go-skip");
  assert.equal(agentBodies(calls).length, 1);
  // Merged with the ones left alone before, over the cap.
  calls = ipcWindow("back", { rewind: [PARTIAL_409(many(600)), PARTIAL_409(many(500, 600))] });
  await R.rewindAct("go");
  await R.rewindAct("go-skip");
  assert.equal(agentBodies(calls)[1].skip.length, 600);
  html = R.rewindSheetHTML();
  assert.doesNotMatch(html, /rewind:go-skip/);
  assert.match(html, /Too many files could not be put back to leave each one alone/);
  await R.rewindAct("go-skip");
  assert.equal(agentBodies(calls).length, 2, "an over-cap skip list was sent");
  assert.equal(R.REWIND.error === "The files to leave as they are could not be read", false);
});

// Issue #80 review: an agent without `skip` ignores it, so a file that keeps failing could never be got past,
// and "from before" claimed files were left alone. The 409 says which agent it is: a new one sends `skipped`.
test("an agent without skip gets the #77 way out with plain words; from before shows only what the agent confirmed", async () => {
  let calls = ipcWindow("back", { rewind: [
    { status: 409, body: partialBody(FIRST_FAILED, { partial: true }) },
    { status: 409, body: partialBody(FIRST_FAILED, { partial: true }) },
    { status: 200, body: { restored: ["/w/src/a.ts"], deleted: [], failed: FIRST_FAILED } },
  ] });
  await R.rewindAct("go");
  let html = R.rewindSheetHTML();
  assert.doesNotMatch(html, /rewind:go-skip/, "an old agent was offered skip");
  assert.doesNotMatch(html, /leave the files listed above as they are/);
  const anyway = html.match(/<button[^>]*data-act="rewind:go-accept"[^>]*>([^<]*)</);
  assert.ok(anyway, "no way past a file that keeps failing on an old agent");
  assert.equal(anyway[1], "Roll back anyway");
  assert.match(html, /tries every file again/);
  assert.match(html, /may overwrite files you edited/);
  assert.match(html, /close or save them first/);
  await R.rewindAct("go-accept");
  assert.deepEqual(agentBodies(calls)[1], { priorQuestions: 1, expectText: "old text", acceptFailed: true });
  // The same file failed again: the notice comes back, and nothing claims it was left alone.
  html = R.rewindSheetHTML();
  assert.doesNotMatch(html, /from before/);
  assert.match(html, /rewind:go-accept/);
  await R.rewindAct("go-accept");
  assert.equal(agentBodies(calls).length, 3);
  assert.doesNotMatch(globalThis.toasts.at(-1)[1], /Left as they are/);
  // Edit words it for the resend.
  ipcWindow("edit", { rewind: [{ status: 409, body: partialBody(FIRST_FAILED, { partial: true }) }] });
  await R.rewindAct("go");
  assert.match(R.rewindSheetHTML(), />Roll back anyway, then resend</);
  // A new agent that did not echo the earlier skip: no "from before".
  calls = ipcWindow("back", { rewind: [PARTIAL_409(FIRST_FAILED), PARTIAL_409([{ path: "/w/late.txt" }], { skipped: [] })] });
  await R.rewindAct("go");
  await R.rewindAct("go-skip");
  assert.doesNotMatch(R.rewindSheetHTML(), /from before/);
  assert.ok(agentBodies(calls).every((b) => !("acceptFailed" in b)));
});

// Issue #80 review: a rollback's late answer landed in a sheet opened meanwhile for another message,
// and Continue there then sent the old paths for a different point.
test("a late rollback answer is ignored by a sheet opened meanwhile", async () => {
  const calls = ipcWindow("back", { rewind: [] });
  let release;
  globalThis.BR.rewind = (...args) => { calls.push(["rewind", args]); return new Promise((r) => { release = r; }); };
  const pending = R.rewindAct("go");
  // The person cancels and opens Edit on another message (rewindStart's reset, a new sheet).
  globalThis.S.log = [{ id: "u9", k: "user", text: "other" }];
  globalThis.priorQuestions = () => 4;
  globalThis.BR.rewindPreview = async () => ({ ok: true, supported: true, data: FILES_PREVIEW });
  R.REWIND.busy = false;
  R.rewindAct("edit:u9");
  await new Promise((r) => setImmediate(r));
  assert.equal(R.REWIND.prior, 4);
  release(M.rewindAnswer(409, partialBody(FIRST_FAILED, { partial: true, skipped: [] })));
  await pending;
  assert.equal(R.REWIND.partial, null, "the old answer's partial restore landed in the new sheet");
  assert.equal(R.REWIND.afterPartial, false);
  assert.equal(R.REWIND.error, null);
  assert.deepEqual(footActs(R.rewindSheetHTML()).map((a) => a[0]), ["rewind:go-chat", "rewind:go"]);
  await R.rewindAct("go-skip");
  assert.equal(calls.filter((c) => c[0] === "rewind").length, 1);
});

// Issue #80 review: "Check again" dropped the person's skips silently, so the fresh preview listed those
// files under "Put back" and the next Roll back overwrote them.
for (const mode of ["back", "edit"]) {
  test(`${mode}: Check again keeps the files chosen to be left alone, marks them, and sends them as skip`, async () => {
    const fresh = { removed: { questions: 1, replies: 1 }, notRestorable: [], uncovered: [],
      files: [{ path: "/w/src/a.ts", action: "restore" }, { path: "/w/locked.txt", action: "restore" }, { path: "/w/dir/a.txt", action: "delete" }] };
    const calls = ipcWindow(mode, {
      rewind: [PARTIAL_409(FIRST_FAILED), { status: 409, body: { error: { code: "point_mismatch", message: "changed" } } },
        { status: 200, body: { restored: ["/w/src/a.ts"], deleted: [], failed: [], skipped: ["/w/locked.txt", "/w/dir/a.txt"] } }],
      preview: [{ status: 200, body: fresh }],
    });
    await R.rewindAct("go");
    await R.rewindAct("go-skip");
    await R.rewindAct("recheck");
    const html = R.rewindSheetHTML();
    const kept = html.split("Left as they are (you chose this)")[1];
    assert.ok(kept, "the files chosen to be left alone are not marked");
    assert.match(kept, /locked\.txt/);
    assert.match(kept, /dir\/a\.txt/);
    const putBack = html.split("Put back as they were")[1].split("</div></div>")[0];
    assert.doesNotMatch(putBack, /locked\.txt/, "a skipped file is listed as put back");
    await R.rewindAct("go");
    assert.deepEqual(agentBodies(calls)[2].skip, ["/w/locked.txt", "/w/dir/a.txt"]);
    // Opening the sheet again drops them.
    globalThis.S.log = [{ id: "u1", k: "user", text: "old text" }];
    globalThis.priorQuestions = () => 1;
    globalThis.S.overlay = null;
    R.rewindAct("back:u1");
    assert.deepEqual([...R.REWIND.skip], []);
  });
}

// Issue #80 review: skip matching is exact, on the agent's own path string; a Windows path goes back unchanged.
test("a Windows path the agent reported goes back in skip exactly as it came", async () => {
  const win = "C:\\Users\\me\\proj\\src\\Locked File.txt";
  const calls = ipcWindow("back", { rewind: [PARTIAL_409([{ path: win, error: "EBUSY" }]), { status: 200, body: { restored: [], deleted: [], failed: [], skipped: [win] } }] });
  globalThis.WORKSPACE = "C:\\Users\\me\\proj";
  await R.rewindAct("go");
  assert.match(R.rewindSheetHTML(), /src\\Locked File\.txt/);
  await R.rewindAct("go-skip");
  assert.deepEqual(agentBodies(calls)[1].skip, [win]);
  assert.match(src("../main/chat-rewind.ts"), /matched exactly/);
});

// Issue #83 (1): a late preview for message A showed in the sheet opened for message B of the same chat,
// and confirming then sent B's position under A's file list.
for (const late of ["files", "error"]) {
  test(`a late preview (${late}) for a sheet closed meanwhile does not replace the sheet opened for another message`, async () => {
    const calls = ipcWindow("back", { rewind: [{ status: 200, body: { restored: [], deleted: [], failed: [] } }] });
    const g = globalThis;
    g.S.log = [{ id: "uA", k: "user", text: "question A" }, { id: "aA", k: "assistant", text: "a" }, { id: "uB", k: "user", text: "question B" }];
    g.priorQuestions = (m) => (m.id === "uA" ? 0 : 1);
    g.S.overlay = null;
    const pending = {};
    g.BR.rewindPreview = (sid, prior, text) => new Promise((resolve) => { pending[text] = resolve; });
    R.rewindAct("back:uA");
    g.S.overlay = null;   // the person closes A's sheet
    R.rewindAct("back:uB");
    const B_PREVIEW = { removed: { questions: 1, replies: 0 }, files: [{ path: "/w/b-only.txt", action: "restore" }], notRestorable: [], uncovered: [] };
    const A_PREVIEW = { removed: { questions: 2, replies: 1 }, files: [{ path: "/w/a-only.txt", action: "restore" }], notRestorable: [], uncovered: [] };
    pending["question B"]({ ok: true, supported: true, data: B_PREVIEW });
    await new Promise((r) => setImmediate(r));
    pending["question A"](late === "files" ? { ok: true, supported: true, data: A_PREVIEW } : { ok: false, supported: true, error: "A went wrong" });
    await new Promise((r) => setImmediate(r));
    assert.equal(g.S.overlay, "rewind", "A's answer closed B's sheet");
    const html = R.rewindSheetHTML();
    assert.match(html, /b-only\.txt/);
    assert.doesNotMatch(html, /a-only\.txt/, "A's file list is on B's sheet");
    assert.doesNotMatch(html, /A went wrong/);
    await R.rewindAct("go");
    assert.deepEqual(agentBodies(calls), [{ priorQuestions: 1, expectText: "question B" }]);
  });
}

test("a late Check again preview does not land in a sheet opened meanwhile", async () => {
  ipcWindow("back", { rewind: [PARTIAL_409(FIRST_FAILED)] });
  const g = globalThis;
  g.S.log = [{ id: "u1", k: "user", text: "old text" }, { id: "uB", k: "user", text: "question B" }];
  g.priorQuestions = (m) => (m.id === "u1" ? 1 : 2);
  await R.rewindAct("go");
  let late;
  g.BR.rewindPreview = () => new Promise((resolve) => { late = resolve; });
  const checking = R.rewindAct("recheck");
  g.S.overlay = null;
  let fresh;
  g.BR.rewindPreview = () => new Promise((resolve) => { fresh = resolve; });
  R.rewindAct("back:uB");
  fresh({ ok: true, supported: true, data: { removed: { questions: 1, replies: 0 }, files: [{ path: "/w/b-only.txt", action: "restore" }], notRestorable: [], uncovered: [] } });
  await new Promise((r) => setImmediate(r));
  late({ ok: true, supported: true, data: FILES_PREVIEW });
  await checking;
  const html = R.rewindSheetHTML();
  assert.match(html, /b-only\.txt/);
  assert.doesNotMatch(html, /src\/a\.ts/);
});
