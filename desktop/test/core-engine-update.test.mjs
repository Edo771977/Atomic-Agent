import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { coreUpdatePlan } = require("../out/main/core-update-notice.js");
const { coreUpdateNeedsStoppedModels } = require("../out/main/engine-failure.js");
const engineSource = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");

const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");

function loadRenderer(names, state = {}) {
  const context = vm.createContext({
    esc: (text) => String(text),
    ic: () => "",
    OB_COPY: { phaseRuntime: "Local engine" },
    render() {},
    llmRepaint() {},
    dlChipBusy: () => false,
    ...state,
  });
  for (const name of names) {
    const index = source.search(new RegExp("^(?:async )?function " + name + "\\(", "m"));
    assert.ok(index >= 0, name + " is a renderer function");
    vm.runInContext(source.slice(index, source.indexOf("\n}", index) + 2), context);
  }
  return context;
}

const versions = { targetVersion: "0.18.6", activeVersion: "0.18.6" };

test("the downloads card gives a waiting Core reinstall two actions, versions and no cloud offer", () => {
  const ui = loadRenderer(["llmCoreUpdateText", "llmCoreUpdateWaitingHTML", "dlCardHTML", "dlCardRowHTML", "dlCardName", "dlRowMoving"]);
  const html = ui.dlCardHTML([{ kind: "runtime", src: "core-update", state: "waiting", id: "the local engine", coreUpdate: versions }]);
  assert.match(html, /Waiting for models to stop/);
  assert.match(html, /Stop models and update/);
  assert.match(html, /Later/);
  assert.match(html, /Target 0\.18\.6 · Active 0\.18\.6/);
  assert.doesNotMatch(html, /Download failed|dlc:retry|dlc:cloud|dlc-bar/);
});

test("Later clears the waiting reinstall without stopping or launching anything", async () => {
  const LLMP = { coreUpdateWaiting: { ...versions, fresh: true } };
  const actions = [];
  const ui = loadRenderer(["llmCoreUpdateAction"], {
    LLMP,
    llmDaemon: async (action) => { actions.push(action); return { ok: true }; },
    llmEngineInstall: () => actions.push("install"),
  });
  await ui.llmCoreUpdateAction("coreLater");
  assert.equal(LLMP.coreUpdateWaiting, null);
  assert.deepEqual(actions, []);
});

test("Stop models and update retries the original install only after the stop succeeds", async () => {
  const actions = [];
  const LLMP = { coreUpdateWaiting: { ...versions, fresh: true } };
  let allowStop = false;
  const ui = loadRenderer(["llmCoreUpdateAction"], {
    LLMP,
    llmDaemon: async (action) => {
      actions.push(action);
      return { ok: allowStop, error: "Still answering a turn" };
    },
    llmEngineInstall: ({ fresh }) => { actions.push("install"); assert.equal(fresh, true); return true; },
  });
  await ui.llmCoreUpdateAction("coreStop");
  assert.deepEqual(actions, ["stop"]);
  assert.equal(LLMP.coreUpdateWaiting.error, "Still answering a turn");
  allowStop = true;
  await ui.llmCoreUpdateAction("coreStop");
  assert.deepEqual(actions, ["stop", "stop", "install"]);
  assert.equal(LLMP.coreUpdateWaiting, null);
});

const cliResult = { ok: true, stdout: "", stderr: "", sawProgress: false, upToDate: false, timedOut: false, keptBackend: false };

async function runEngineInstall({ activeVersion, requiresStop, result = cliResult, fresh = false }) {
  const frames = [];
  const calls = [];
  const begin = engineSource.indexOf("function engineInstallStream(");
  const end = engineSource.indexOf("\n}", begin) + 2;
  const code = ts.transpileModule(engineSource.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({
    AbortController,
    coreUpdatePlan,
    coreUpdateNeedsStoppedModels,
    downloadRunning: () => null,
    smokeOffline: false,
    pullUpdate: null,
    managedEngineNow: () => "atomic-core",
    managedDataDirNow: () => "/test",
    modelsEngine: async (action, _signal, options) => {
      assert.equal(action, "status");
      assert.equal(options.updatePlan, true);
      return { value: { engine: "atomic-core", updatePlan: { ...versions, activeVersion, requiresStop } } };
    },
    updateInTurn: (_signal, _stopped, run) => Promise.resolve().then(run),
    updateBegins: () => { throw new Error("Core should not suspend model supervision"); },
    resetCoreForRedownload: () => { calls.push("reset"); },
    modelsUpdateStream: () => {
      calls.push("spawn");
      return { done: Promise.resolve(result), cancel() {} };
    },
    engineBusy: () => false,
    updateSwept: (ended) => ended,
    pullFrame: (_slot, frame) => frames.push(frame),
    send: (_channel, frame) => frames.push(frame),
    A: { runtimeUpdated: () => calls.push("download-result") },
    noteEngine() {},
    sayDesktop() {},
    startAfterEngineInstall() {},
  });
  vm.runInContext(code, context);
  const update = context.engineInstallStream("settings", { fresh });
  await update.done;
  return { calls, frames };
}

test("a known same-version refusal waits before starting the download or resetting Core", async () => {
  const { calls, frames } = await runEngineInstall({ activeVersion: versions.activeVersion, requiresStop: true, fresh: true });
  assert.deepEqual(calls, []);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].done, true);
  assert.equal(frames[0].waitingForModels, true);
  assert.equal(frames[0].fresh, true);
  assert.equal(frames[0].coreUpdate.targetVersion, versions.targetVersion);
  assert.equal(frames[0].coreUpdate.activeVersion, versions.activeVersion);
});

test("a refusal from the CLI after preflight also becomes waiting", async () => {
  const result = { ...cliResult, ok: false, stderr: "Stop local models before updating the engine. Your running models are unchanged.\n" };
  const { calls, frames } = await runEngineInstall({ activeVersion: versions.activeVersion, requiresStop: false, result });
  assert.deepEqual(calls, ["spawn"]);
  assert.equal(frames[0].started, true);
  assert.equal(frames[1].waitingForModels, true);
  assert.equal(frames[1].done, true);
});

test("a newer pin starts without stopping or resetting the active Core and reports deferred activation", async () => {
  const result = { ...cliResult, stdout: "installed. Atomic Chat switches to it at the next start once local models are stopped.\n" };
  const { calls, frames } = await runEngineInstall({ activeVersion: "0.16.0", requiresStop: false, fresh: true, result });
  assert.deepEqual(calls, ["spawn", "download-result"]);
  assert.equal(frames[0].coreUpdate.targetVersion, versions.targetVersion);
  assert.equal(frames[0].coreUpdate.activeVersion, "0.16.0");
  assert.equal(frames[1].coreActivationPending, true);
  assert.equal(frames[1].waitingForModels, undefined);
});
