import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { USER_CONFIG_VERSION } from "../config/config-schema.js";
import { stateDirProjectRecords } from "../session/project-decisions.js";
import { openProject } from "../session/project-store.js";
import { PLAN_REVIEW_DIMENSIONS, planReviewFresh } from "../tools/fusion/plan-review-record.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = join(root, "docs", "testing", "fixtures", "document");
const prompt = readFileSync(join(fixture, "prompt.txt"), "utf8").trimEnd();
const report = readFileSync(join(fixture, "live-report.md"), "utf8");
const cli = join(root, "src", "cli", "index.ts");
const title = "Scrivi report.md con i risultati settimanali del servizio, includi le richieste ricevute e risolte, spiega quali sono ancora in attesa del supporto e indica il tempo medio di risposta";
const taskReviewer = "reviewer:reviewer";
const planReviewer = "plan-reviewer:plan-reviewer";
const runFile = promisify(execFile);
const documentCheck = {
  kind: "document", path: "report.md", criteria: ["document"],
  requiredSections: ["Sintesi", "Risultati", "Prossimi passi"],
  wordRange: { min: 80, max: 130 }, language: "it",
};

const call = (tool: string, args: Record<string, unknown>) => JSON.stringify([{ tool, args }]);
const reply = call("reply", { text: "Fatto." });

function directorScript(review: "on" | "off") {
  return [
    call("project.brief", {
      what: "Rapporto settimanale di servizio", users: "Team di supporto", how: "Markdown",
      deliverable: "document",
      successCriteria: [{ id: "document", text: "report.md in italiano, 80–130 parole, tre sezioni richieste e nessun segnaposto." }],
    }),
    reply,
    call("project.plan", {
      milestones: [{ id: "delivery", title: "Consegna", kind: "base" }],
      tasks: [{
        id: "report", title, milestone: "delivery",
        ...(review === "off" ? { reviewer: taskReviewer } : {}),
        checks: [documentCheck],
      }],
    }),
    reply,
    call("fusion.delegate", {
      tasks: [{ id: "report", instructions: "Scrivi il rapporto richiesto in report.md.", files: ["report.md"] }],
      contract: { checks: [{ task: "report", ...documentCheck }] },
    }),
    call("project.milestone", { id: "delivery", state: "done", summary: "Rapporto consegnato." }),
    reply,
  ];
}

it.each(["on", "off"] as const)("delivers the document through the Fusion CLI with team.review=%s", async (review) => {
  const folder = mkdtempSync(join(realpathSync(tmpdir()), "atomic-document-"));
  const cwd = join(folder, "project");
  const stateDir = join(folder, "state");
  const egress = join(folder, "egress.ndjson");
  const unexpected: string[] = [];
  const scripts = new Map([
    ["director", directorScript(review)],
    ["worker", [call("os.fs.write", { path: "report.md", content: report }), reply]],
    ["plan-reviewer", [JSON.stringify({
      results: PLAN_REVIEW_DIMENSIONS.map(dimension => ({ dimension, verdict: "pass", detail: "Piano verificato.", taskIds: [] })),
    })]],
    ["reviewer", review === "on" ? [JSON.stringify({ decision: "accept", issues: [] })] : []],
  ]);
  const server = createServer(async (req, res) => {
    try {
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [...scripts.keys()].map(id => ({ id })) }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") throw new Error(`Unexpected endpoint: ${req.method} ${req.url}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw) as { model: string; stream?: boolean };
      const auxiliary = raw.includes("Name this work session.");
      const content = auxiliary ? "Rapporto settimanale" : scripts.get(body.model)?.shift();
      if (content === undefined) throw new Error(`Unexpected completion for ${body.model}: ${raw.slice(-600)}`);
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage }));
      }
    } catch (error) {
      unexpected.push(String(error));
      res.writeHead(400).end(String(error));
    }
  });

  try {
    mkdirSync(join(cwd, ".atomic-agent", "skills"), { recursive: true });
    mkdirSync(stateDir);
    writeFileSync(egress, "");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({
      version: USER_CONFIG_VERSION,
      agent: { approvalLevel: 5 },
      memory: { reflection: { enabled: false } },
      llm: {
        activeTextProvider: "director",
        toolTransport: "grammar",
        providers: [...scripts.keys()].map(id => ({
          id, kind: "openai-compatible", baseUrl: `http://127.0.0.1:${address.port}/v1`,
          defaultChatModel: id, apiKey: "fixture-only",
        })),
        runMode: { mode: "fusion", fusion: {
          orchestratorProvider: "director", workerProvider: "worker",
          team: {
            directors: ["director:director"], workers: ["worker:worker"],
            reviewers: [taskReviewer], planReviewer, review,
          },
        } },
      },
    }));

    // Same in-memory credential behavior as the receipt tests, at the
    // native binding boundary so the production CLI still signs receipts.
    const keyring = join(folder, "keyring.cjs");
    writeFileSync(keyring, `
      const passwords = new Map();
      exports.Entry = class {
        constructor(service, account) { this.key = JSON.stringify([service, account]); }
        getPassword() { return passwords.get(this.key) ?? null; }
        setPassword(password) { passwords.set(this.key, password); }
        deletePassword() { return passwords.delete(this.key); }
      };
    `);
    const preload = join(folder, "keyring-preload.mjs");
    writeFileSync(preload, `
      import { registerHooks } from "node:module";
      registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "@napi-rs/keyring") {
            return { url: ${JSON.stringify(pathToFileURL(keyring).href)}, format: "commonjs", shortCircuit: true };
          }
          return nextResolve(specifier, context);
        }
      });
    `);
    const env = {
      Path: process.env.Path ?? process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: folder, USERPROFILE: folder,
      TEMP: folder, TMP: folder, TMPDIR: folder,
      ATOMIC_AGENT_STATE_DIR: stateDir,
      ATOMIC_AGENT_GRAMMARS_DIR: join(root, "grammars"),
      ATOMIC_AGENT_ANALYTICS: "off",
      ATOMIC_AGENT_BROWSER_ENABLED: "false",
      ATOMIC_AGENT_NET_INTERCEPT_LOG: egress,
      NODE_OPTIONS: `--import=${pathToFileURL(join(root, "scripts", "net-intercept-preload.mjs")).href}`,
    };
    const run = runFile(process.execPath, [
      "--import", "tsx", "--import", pathToFileURL(preload).href, cli,
      "run", "--cwd", cwd, "--reviewer", "team", "--auto-approve-project",
    ], { cwd: root, env, timeout: 20_000, killSignal: "SIGKILL" });
    run.child.stdin!.end(prompt + "\n");
    const result = await run.catch((error) => {
      throw new Error(`Fusion CLI failed: ${error.message}\n${error.stdout}\n${error.stderr}\n${unexpected.join("\n")}`);
    });
    expect(unexpected, result.stderr).toEqual([]);
    expect([...scripts].map(([model, queue]) => [model, queue.length]), result.stdout + result.stderr).toEqual([...scripts.keys()].map(model => [model, 0]));
    expect(readFileSync(join(cwd, "report.md"), "utf8")).toBe(report);

    const evidence = spawnSync(process.execPath, [
      join(root, "scripts", "e2e-artifacts.mjs"), "--cwd", cwd, "--fixture", "document", "--state-dir", stateDir,
    ], { cwd: root, env, encoding: "utf8", timeout: 12_000, killSignal: "SIGKILL" });
    expect(evidence.status, evidence.error?.message ?? evidence.stderr + evidence.stdout).toBe(0);
    const execution = JSON.parse(evidence.stdout).execution;
    expect(execution.tasks).toHaveLength(1);
    if (review === "on") {
      expect(execution.tasks[0]).toMatchObject({
        taskId: "report", latest: { decision: "accept", join: "key" },
        latestReview: { planned: taskReviewer, reviewedBy: "reviewer", recorded: taskReviewer },
      });
    } else {
      const planResult = /project\.plan ok: ([\s\S]*?)(?=\r?\n\[)/.exec(result.stderr)?.[1];
      expect(planResult).toContain("review is off for this run (team.review is off)");
      expect(execution.tasks[0]).toMatchObject({ taskId: "report", reviewer: null });
    }

    const stored = openProject(cwd, { stateDir, records: stateDirProjectRecords(stateDir) });
    if (!stored.ok) throw new Error(stored.problem.message);
    const project = stored.opened.project;
    expect(project).toMatchObject({
      gate: { kind: "none" },
      plan: {
        status: "approved", rows: [{ taskId: "report" }],
        review: { outcome: "reviewed", reviewer: planReviewer, sentBack: false },
      },
      milestones: [{ id: "delivery", state: "reviewed", criteriaFacts: [{ id: "document", state: "passed" }] }],
    });
    expect(title.length).toBeGreaterThan(160);
    expect(project.plan?.rows[0]?.title).toHaveLength(160);
    expect(planReviewFresh(project.plan!, ["delivery"])).toBe(true);

    const verified = spawnSync(process.execPath, ["--import", "tsx", cli, "project", "verify", cwd, "--json"], {
      cwd: root, env, encoding: "utf8", timeout: 12_000, killSignal: "SIGKILL",
    });
    expect(verified.status, verified.error?.message ?? verified.stderr + verified.stdout).toBe(0);
    const receipts = JSON.parse(verified.stdout) as { kind: string; status: string }[];
    expect(receipts.filter(receipt => receipt.kind === "gate-verdict")).toHaveLength(3);
    expect(receipts.filter(receipt => receipt.kind === "milestone-report")).toHaveLength(1);
    expect(receipts.map(receipt => receipt.status)).toEqual(receipts.map(() => "valid"));
    expect(readFileSync(egress, "utf8")).toBe("");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
}, 50_000);
