#!/usr/bin/env node
/**
 * Record one live run of the CSV sales fixture (issue #95, item 4) in one
 * JSON report: our independent acceptance test and the agent's own tests
 * (exit codes and counts), the persisted project and milestone state, the
 * per-task verdicts and the turn receipts' spend.
 *
 *   node scripts/e2e-csv-sales.mjs --cwd <run folder> [--state-dir <dir>]
 *     [--session <id>] [--log <file>]... [--run-exit <code>] [--output <report.json>]
 *
 * `--cwd` is the folder `atomic-agent run --cwd` worked in (sales.cjs and
 * sales.test.cjs). `--state-dir` is the agent's data folder (default
 * ATOMIC_AGENT_STATE_DIR, else ~/.atomic-agent); the session and the project
 * are read from its sessions.sqlite (read-only), the verdicts and receipts
 * from fusion/outcomes.ndjson. `--log` names the run's saved stdout or
 * stderr (repeatable): a printed `session: <id>` names the session, and the
 * `fusion receipt ·` lines are kept. Without `--session` or a printed id,
 * the newest session in `--cwd` is used. `--run-exit` records the run's own
 * exit code (3: stopped at a project gate). Node built-ins only, no shell:
 * the same command works on Windows and POSIX. The report goes to stdout,
 * or to `--output`. Exit 0 only when nothing blocks (`blocking`: both
 * suites pass, every plan task's latest verdict is an accept, the milestone
 * state agrees and no gate waits), 1 otherwise, 2 on a usage error.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ACCEPTANCE_TEST = resolve(HERE, '../docs/testing/fixtures/csv-sales/acceptance.test.cjs');
export const PROGRAM_FILE = 'sales.cjs';
export const AGENT_TEST_FILE = 'sales.test.cjs';
const OUTCOME_LOG_KEEP = 2;   // src/tools/fusion/outcome-log.ts OUTCOME_LOG_KEEP

const USAGE = 'usage: node scripts/e2e-csv-sales.mjs --cwd <run folder> [--state-dir <dir>] [--session <id>] [--log <file>]... [--run-exit <code>] [--output <report.json>]';

/** The command line, or `{error}`. */
export function parseArgs(argv) {
  const out = { cwd: null, stateDir: null, session: null, logs: [], runExit: null, output: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    const need = () => { if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`); i++; return value; };
    try {
      if (flag === '--cwd') out.cwd = need();
      else if (flag === '--state-dir') out.stateDir = need();
      else if (flag === '--session') out.session = need();
      else if (flag === '--log') out.logs.push(need());
      else if (flag === '--output') out.output = need();
      else if (flag === '--run-exit') {
        const v = need();
        if (!/^-?[0-9]+$/.test(v)) throw new Error('--run-exit needs a whole number');
        out.runExit = Number(v);
      } else if (flag === '--help' || flag === '-h') return { help: true };
      else throw new Error(`unknown option ${flag}`);
    } catch (e) {
      return { error: e.message };
    }
  }
  if (!out.cwd) return { error: '--cwd is required' };
  return out;
}

/** TAP counts from `node --test --test-reporter=tap`, and the names of the failing tests. */
export function parseTap(text) {
  const count = (name) => { const m = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(text); return m ? Number(m[1]) : null; };
  const failed = [...text.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].replace(/\s+#.*$/, '').trim());
  return { tests: count('tests'), pass: count('pass'), fail: count('fail'), failed };
}

/** Runs one test file with `node --test`, without a shell, in `cwd`. */
export function runNodeTest(file, cwd, env = {}) {
  if (!existsSync(file)) return { file, exitCode: null, error: 'not found', tests: null, pass: null, fail: null, failed: [] };
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
    cwd, encoding: 'utf8', timeout: 5 * 60_000, env: { ...process.env, ...env },
  });
  if (r.error) return { file, exitCode: null, error: String(r.error.message || r.error), tests: null, pass: null, fail: null, failed: [] };
  return { file, exitCode: r.status, ...(r.signal ? { signal: r.signal } : {}), ...parseTap(r.stdout || '') };
}

/** The session id the run printed (`session: <id>` at a project gate), else null. */
export function sessionIdFromOutput(text) {
  const all = [...String(text).matchAll(/^session: ([A-Za-z0-9_.:-]+)\s*$/gm)];
  return all.length ? all[all.length - 1][1] : null;
}

/** The `fusion receipt · …` lines a run printed, as they read. */
export function receiptLines(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => /^fusion receipt · /.test(l));
}

/** The outcome log's session tag (src/tools/fusion/outcome-log.ts sessionTag). */
export function sessionTag(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
}

/** An outcome row's `taskKey` / `milestoneKey`: sha256 of the UTF-8 id, its first 16 hex characters. */
export function outcomeKey(id) {
  return createHash('sha256').update(String(id), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The plan's tasks, each with its verdicts. A verdict with a `taskKey`
 * goes to the row whose task id (and milestone id, when the verdict has
 * one) gives the same keys: `join: "key"`. A verdict without keys (an
 * older build) goes, in order, to the rows no keyed verdict reached:
 * `join: "order (unjoined)"`, a guess. `unmatched` gets the rest.
 */
export function joinVerdictsAll(project, verdicts) {
  const rows = project && project.plan ? project.plan.rows : [];
  const tasks = rows.map((r) => ({ ...r, verdicts: [] }));
  const byKey = new Map(tasks.map((t) => [outcomeKey(t.taskId), t]));
  const unmatched = [];
  const unkeyed = [];
  for (const v of verdicts) {
    if (!v.taskKey) { unkeyed.push(v); continue; }
    const t = byKey.get(v.taskKey);
    if (t && (!v.milestoneKey || v.milestoneKey === outcomeKey(t.milestoneId))) t.verdicts.push({ join: 'key', ...v });
    else unmatched.push(v);
  }
  const open = tasks.filter((t) => t.verdicts.length === 0);
  unkeyed.forEach((v, i) => {
    if (i < open.length) open[i].verdicts.push({ join: 'order (unjoined)', ...v });
    else unmatched.push(v);
  });
  for (const t of tasks) {
    const last = t.verdicts[t.verdicts.length - 1] || null;
    t.latest = last ? { status: last.status, decision: last.review ? last.review.decision : null, attempt: last.attempt ?? null, join: last.join } : null;
    t.latestReview = reviewIdentity(t);
  }
  return { tasks, unmatched };
}

/**
 * Issue #98: the reviewer of a task's latest reviewed verdict next to the
 * plan's: `recorded` is the ref the row wrote, `provider` / `model` the
 * effective ones and `planRef` the ref the plan named, when the row carries
 * them. `mismatch`: the plan's ref is not the one the review ran under.
 */
function reviewIdentity(task) {
  const reviewed = [...task.verdicts].reverse().find((v) => v.review);
  if (!reviewed) return null;
  const r = reviewed.review;
  const planned = task.reviewer ?? null;
  const recorded = r.reviewer ?? (r.provider && r.model ? `${r.provider}:${r.model}` : null);
  return {
    planned,
    recorded,
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.planRef ? { planRef: r.planRef } : {}),
    mismatch: planned !== null && (r.planRef ? r.planRef !== planned : recorded !== planned),
  };
}

/** Whether a plan task is done as the fixture requires: its latest verdict is a review's `accept` (or `ok` with no review planned). */
function taskAccepted(task) {
  const last = task.verdicts[task.verdicts.length - 1];
  if (!last) return false;
  if (task.reviewer === null || task.reviewer === undefined) return last.status === 'ok' || (last.review && last.review.decision === 'accept');
  return Boolean(last.review && last.review.decision === 'accept');
}

/** Why a task is not accepted, in one line naming it. */
function taskBlock(task) {
  const name = `task ${task.taskId} (${task.title || 'untitled'})`;
  if (task.verdicts.length === 0) return `${name}: no verdict`;
  const last = task.verdicts[task.verdicts.length - 1];
  const reviewed = [...task.verdicts].reverse().find((v) => v.review);
  const said = reviewed
    ? `${reviewed.review.decision}${reviewed.review.blockers ? ` (${reviewed.review.blockers} blocker${reviewed.review.blockers === 1 ? '' : 's'})` : ''}`
    : 'no review';
  return `${name}: not accepted: ${said}${reviewed && reviewed !== last ? `, then ${last.status} with no new verdict` : (!reviewed ? `, latest ${last.status}` : '')}`;
}

/**
 * Issue #98: what keeps the run from passing. Both suites must pass, every
 * plan task's latest verdict must be an accept, each milestone's state must
 * agree (done or reviewed exactly when all its tasks are accepted) and no
 * gate may be waiting.
 */
export function blockingReasons({ tests, project, tasks }) {
  const out = [];
  if (!tests || !tests.passed) out.push('the test suites did not both pass');
  if (!project) { out.push('no project was stored for the session'); return out; }
  if (!tasks.length) out.push('the plan has no tasks');
  for (const t of tasks) if (!taskAccepted(t)) out.push(taskBlock(t));
  for (const m of project.milestones || []) {
    const mine = tasks.filter((t) => t.milestoneId === m.id);
    const open = mine.filter((t) => !taskAccepted(t)).length;
    const closed = m.state === 'done' || m.state === 'reviewed';
    if (open > 0 && closed) out.push(`milestone ${m.id} is ${m.state} while ${open} required task${open === 1 ? ' is' : 's are'} not accepted`);
    if (open === 0 && mine.length > 0 && !closed) out.push(`milestone ${m.id} is ${m.state} although every task is accepted`);
  }
  if (project.gate && project.gate.kind && project.gate.kind !== 'none') out.push(`the project waits at its ${project.gate.kind} gate`);
  return out;
}

/** The texts `--auto-approve-project` sends after it approves a gate (src/session/project-continue.ts). */
const AUTO_CONTINUE = [/^I approved the project brief\. Draft the plan\.$/, /^I approved\. Continue with milestone ".*"\.$/s];

/**
 * Issue #98: a single autonomous run, or a guided resume. A person's line
 * after the first prompt (anything but an auto-approval continuation), or
 * logs that stop at a project gate more than once (each stop ends a run),
 * make it guided.
 */
export function runMode(turns, logText) {
  const users = (Array.isArray(turns) ? turns : []).filter((t) => t && t.kind === 'user');
  const human = users.slice(1).filter((u) => !AUTO_CONTINUE.some((re) => re.test(String(u.text || '').trim())));
  const stops = [...String(logText).matchAll(/^session: \S+\s*$/gm)].length;
  const runStarts = Math.max(1, stops);
  const reasons = [];
  if (human.length) {
    const first = String(human[0].text || '').replace(/\s+/g, ' ').slice(0, 80);
    reasons.push(`${human.length} line${human.length === 1 ? '' : 's'} from a person after the first prompt, first: "${first}"`);
  }
  if (runStarts > 1) reasons.push(`${runStarts} runs: the logs stop at a project gate ${stops} times`);
  return { kind: reasons.length ? 'guided' : 'autonomous', userTurns: users.length, humanInputs: human.length, runStarts, reasons };
}
export function joinVerdicts(project, verdicts) {
  return joinVerdictsAll(project, verdicts).tasks;
}

const roundUsd = (n) => Math.round(n * 1e6) / 1e6;

/**
 * The session's records of the outcome log (NDJSON lines): one verdict per
 * finished task, oldest first, and the turn receipts with their spend. The
 * log holds no task id or title, only counts and categories.
 */
export function outcomeSummary(lines, sessionId) {
  const tag = sessionTag(sessionId);
  const tasks = [];
  const turns = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || rec.session !== tag) continue;
    if (rec.type === 'task') {
      tasks.push({
        ts: rec.ts ?? null,
        leg: rec.leg ?? null,
        taskRole: rec.taskRole ?? null,
        worker: rec.provider && rec.model ? `${rec.provider}:${rec.model}` : (rec.model ?? null),
        attempt: rec.attempt ?? null,
        status: rec.status ?? null,
        failure: rec.failure ?? null,
        acceptance: rec.acceptance ?? null,
        taskChecks: rec.taskChecks ?? null,
        selfCheckPassed: rec.selfCheckPassed ?? null,
        review: rec.review
          ? { decision: rec.review.decision ?? null, reviewer: rec.review.reviewer ?? null, passes: rec.review.passes ?? null,
            blockers: rec.review.blockers ?? 0, majors: rec.review.majors ?? 0, minors: rec.review.minors ?? 0,
            // Issue #98: who reviewed, when the row says (provider, effective model, the ref the plan named).
            ...(typeof rec.review.provider === 'string' ? { provider: rec.review.provider } : {}),
            ...(typeof rec.review.model === 'string' ? { model: rec.review.model } : {}),
            ...(typeof rec.review.planRef === 'string' ? { planRef: rec.review.planRef } : {}) }
          : null,
        costUsd: rec.costUsd ?? null,
        // Issue #95: keys of the plan row's task and milestone ids (outcomeKey); absent on older builds.
        taskKey: typeof rec.taskKey === 'string' ? rec.taskKey : null,
        milestoneKey: typeof rec.milestoneKey === 'string' ? rec.milestoneKey : null,
      });
    } else if (rec.type === 'turn') {
      const o = rec.orchestrator || {};
      turns.push({
        ts: rec.ts ?? null,
        provider: o.provider ?? null,
        model: o.model ?? null,
        requests: o.requests ?? null,
        strongCostUsd: o.costUsd ?? null,
        workerCostUsd: rec.workerCostUsd ?? null,
        tasks: rec.tasks ?? null,
      });
    }
  }
  tasks.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  turns.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const priced = (k) => turns.filter((t) => typeof t[k] === 'number');
  const sum = (k) => (priced(k).length ? roundUsd(priced(k).reduce((s, t) => s + t[k], 0)) : null);
  return {
    sessionTag: tag,
    tasks,
    receipts: {
      turns,
      strongUsd: sum('strongCostUsd'),
      workerUsd: sum('workerCostUsd'),
      unpricedTurns: turns.filter((t) => t.strongCostUsd === null).length,
    },
    unreviewedTasks: tasks.filter((t) => t.review === null).length,
  };
}

/** The persisted project as the report shows it: gate, plan rows and milestone states. */
export function projectSummary(project) {
  if (!project || typeof project !== 'object') return null;
  const plan = project.plan || null;
  return {
    gate: project.gate ? { kind: project.gate.kind ?? null, ...(project.gate.id ? { id: project.gate.id } : {}) } : null,
    brief: project.brief ? { status: project.brief.status ?? null, version: project.brief.version ?? null } : null,
    plan: plan
      ? {
        status: plan.status ?? null,
        version: plan.version ?? null,
        rows: (plan.rows || []).map((r) => ({
          taskId: r.taskId, title: r.title, milestoneId: r.milestoneId, worker: r.worker, reviewer: r.reviewer ?? null,
        })),
      }
      : null,
    milestones: (project.milestones || []).map((m) => ({
      id: m.id,
      title: m.title,
      state: m.state,
      runIds: m.runIds || [],
      criteriaFacts: m.criteriaFacts || [],
      ...(m.summary ? { summary: m.summary } : {}),
    })),
    cancelledAt: project.cancelledAt ?? null,
  };
}

/** The session row (`id`, `working_dir`, `status`, `payload` JSON) from sessions.sqlite, read-only. */
export async function readSession(dbFile, { session = null, cwd = null } = {}) {
  if (!existsSync(dbFile)) return { error: `no session store at ${dbFile}` };
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = session
      ? db.prepare('SELECT id, working_dir, status, payload, updated_at FROM sessions WHERE id = ?').get(session)
      : db.prepare('SELECT id, working_dir, status, payload, updated_at FROM sessions WHERE working_dir = ? ORDER BY updated_at DESC, id DESC LIMIT 1').get(cwd);
    if (!row) return { error: session ? `no session ${session} in ${dbFile}` : `no session in ${cwd} in ${dbFile}` };
    let payload = null;
    try { payload = JSON.parse(row.payload); } catch { return { error: `session ${row.id} has an unreadable payload` }; }
    return { id: row.id, workingDir: row.working_dir, status: row.status, updatedAt: row.updated_at, payload };
  } finally {
    db.close();
  }
}

/** The outcome log's lines, the oldest rotated file first. */
export function readOutcomeLines(stateDir) {
  const live = join(stateDir, 'fusion', 'outcomes.ndjson');
  const files = [live, ...Array.from({ length: OUTCOME_LOG_KEEP }, (_, i) => `${live}.${i + 1}`)].reverse();
  return files.filter((f) => existsSync(f)).flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/));
}

/** Builds the report. `deps` replaces the test runs (unit tests). */
export async function buildReport(args, deps = {}) {
  const cwd = resolve(args.cwd);
  const stateDir = resolve(args.stateDir || process.env.ATOMIC_AGENT_STATE_DIR || join(homedir(), '.atomic-agent'));
  const run = deps.runNodeTest || runNodeTest;
  const logs = args.logs.map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : ''));
  const logText = logs.join('\n');
  const printed = sessionIdFromOutput(logText);
  const acceptance = run(ACCEPTANCE_TEST, cwd, { CSV_SALES_PROGRAM: join(cwd, PROGRAM_FILE) });
  const agentTests = run(join(cwd, AGENT_TEST_FILE), cwd, {});
  const stored = await readSession(join(stateDir, 'sessions.sqlite'), { session: args.session || printed, cwd });
  const sessionId = stored.id || args.session || printed || null;
  const outcomes = sessionId ? outcomeSummary(readOutcomeLines(stateDir), sessionId) : null;
  const passed = acceptance.exitCode === 0 && agentTests.exitCode === 0;
  const project = stored.payload ? projectSummary(stored.payload.project) : null;
  const joined = joinVerdictsAll(project, outcomes ? outcomes.tasks : []);
  const tests = { acceptance, agent: agentTests, passed };
  const blocking = blockingReasons({ tests, project, tasks: joined.tasks });
  return {
    fixture: 'csv-sales',
    recordedAt: new Date().toISOString(),
    cwd,
    stateDir,
    run: { exitCode: args.runExit, logs: args.logs.map((f) => resolve(f)), printedSession: printed, receiptLines: receiptLines(logText) },
    session: stored.error ? { id: sessionId, error: stored.error } : { id: stored.id, status: stored.status, workingDir: stored.workingDir },
    // Issue #98: the run passes only when nothing blocks (both suites, an accept per task, a consistent milestone).
    passed: blocking.length === 0,
    blocking,
    mode: runMode(stored.payload ? stored.payload.turns : [], logText),
    tests,
    project,
    // Each plan task with its verdicts (joined by key, else by order and labelled), then the ones no task took.
    tasks: joined.tasks,
    unmatchedVerdicts: joined.unmatched,
    verdicts: outcomes ? outcomes.tasks : [],
    unreviewedTasks: outcomes ? outcomes.unreviewedTasks : null,
    receipts: outcomes ? outcomes.receipts : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ('help' in args) { process.stdout.write(USAGE + '\n'); return 0; }
  if ('error' in args) { process.stderr.write(`${args.error}\n${USAGE}\n`); return 2; }
  const report = await buildReport(args);
  const text = JSON.stringify(report, null, 2) + '\n';
  if (args.output) writeFileSync(args.output, text);
  else process.stdout.write(text);
  if (args.output) process.stderr.write(`report: ${resolve(args.output)}\n`);
  return report.passed ? 0 : 1;
}

/** Run as a script, not imported (a Windows drive letter may differ in case). */
function isMain() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isMain()) {
  main().then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`${err && err.stack ? err.stack : err}\n`); process.exitCode = 1; });
}
