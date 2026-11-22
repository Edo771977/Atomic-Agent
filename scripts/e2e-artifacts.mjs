#!/usr/bin/env node
/** Report a completed Fusion artifact run using the same file checks as verify.run. */
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  blockingReasons, joinVerdictsAll, outcomeSummary, projectSummary, readOutcomeLines, readSession, sessionTag,
} from './e2e-csv-sales.mjs';

const FIXTURES = {
  document: {
    path: 'report.md',
    checks: [
      ['placeholders', {}],
      ['sections', { requiredSections: ['Sintesi', 'Risultati', 'Prossimi passi'] }],
      ['word-count', { wordRange: { min: 80, max: 130 } }],
      ['language', { language: 'it' }],
    ],
  },
  spreadsheet: {
    path: 'sales.xlsx',
    checks: [
      ['formula-errors', {}],
      ['sheets', { requiredSheets: ['Sales'] }],
      ['columns', { requiredColumns: [{ sheet: 'Sales', columns: ['Item', 'Amount'] }] }],
      ['total', { totals: [{ sheet: 'Sales', range: 'B2:B3', totalCell: 'B4', tolerance: 0.01 }] }],
    ],
  },
};

const USAGE = 'usage: node scripts/e2e-artifacts.mjs --cwd <run folder> [--fixture document|spreadsheet] [--state-dir <dir>] [--session <id>] [--output <report.json>]';
const FLAGS = new Map([['--cwd', 'cwd'], ['--fixture', 'fixture'], ['--state-dir', 'stateDir'], ['--session', 'session'], ['--output', 'output']]);

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const key = FLAGS.get(flag);
    if (!key) return { error: `unknown option ${flag}` };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || value.trim() === '') return { error: `${flag} needs a value` };
    if (Object.hasOwn(args, key)) return { error: `${flag} was given more than once` };
    args[key] = value;
  }
  if (!args.cwd) return { error: '--cwd is required' };
  if (args.fixture !== undefined && !Object.hasOwn(FIXTURES, args.fixture)) {
    return { error: '--fixture must be document or spreadsheet' };
  }
  return args;
}

let runtimeModule;
function loadRuntime() {
  runtimeModule ??= import('tsx/esm/api').then(({ tsImport }) => tsImport('./e2e-artifact-runtime.ts', import.meta.url));
  return runtimeModule;
}

function selectFixture(cwd, fixture) {
  if (fixture !== undefined) return Object.hasOwn(FIXTURES, fixture) ? fixture : null;
  const found = Object.entries(FIXTURES).filter(([, spec]) => existsSync(join(cwd, spec.path)));
  return found.length === 1 ? found[0][0] : null;
}

async function inspectArtifact(cwd, fixture, runVerify) {
  if (fixture === null) {
    return { path: null, passed: false, checks: [], error: 'specify --fixture document or spreadsheet when no unique delivery filename identifies the fixture' };
  }
  const spec = FIXTURES[fixture];
  const verify = async (rules) => {
    try {
      const result = await runVerify({ kind: fixture, path: spec.path, ...rules }, { workingDir: cwd });
      return { status: result.artifactStatus ?? 'uncheckable', detail: result.stdoutTail ?? result.error ?? result.summary };
    } catch (error) {
      return { status: 'uncheckable', detail: error instanceof Error ? error.message : String(error) };
    }
  };
  // A single snapshot must satisfy all criteria. On a non-pass, run the
  // narrower specs for diagnostics without letting them override that result.
  const combinedRules = Object.assign({}, ...spec.checks.map(([, rules]) => rules));
  const combined = await verify(combinedRules);
  const passed = combined.status === 'pass';
  const checks = passed
    ? spec.checks.map(([id]) => ({ id, ...combined }))
    : await Promise.all(spec.checks.map(async ([id, rules]) => ({ id, ...await verify(rules) })));
  return { path: spec.path, passed, checks, combined };
}

async function selectSession(cwd, stateDir, session, sameProjectFolder) {
  try {
    const db = join(stateDir, 'sessions.sqlite');
    let stored = await readSession(db, { session, cwd });
    if (!session && stored.error) {
      const canonical = realpathSync(cwd);
      if (canonical !== cwd) stored = await readSession(db, { cwd: canonical });
    }
    if (!stored.error && !sameProjectFolder(cwd, stored.workingDir)) {
      return { error: `session ${stored.id} belongs to a different working directory` };
    }
    return stored;
  } catch (error) {
    return { error: `could not read the session: ${error.message}` };
  }
}

/** Count concrete invocation evidence. A task outcome or attempt number alone is insufficient. */
function workerEvidence(lines, session, candidateWorkerRuns) {
  const tag = session ? sessionTag(session) : null;
  let taskRecords = 0;
  let known = 0;
  let withoutCounts = 0;
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || record.type !== 'task' || record.session !== tag || tag === null) continue;
    taskRecords++;
    const count = candidateWorkerRuns(record);
    if (count === undefined) withoutCounts++;
    else known += count;
  }
  const count = taskRecords === 0 || withoutCounts !== 0 ? null : known;
  return {
    count, known, taskRecords, withoutCounts,
    ...(count === null ? { reason: taskRecords === 0 ? 'no task outcome records for this session' : 'some task records have no explicit worker invocation count' } : {}),
  };
}

async function inspectExecution(cwd, stateDir, session, runtime) {
  const stored = await selectSession(cwd, stateDir, session, runtime.sameProjectFolder);
  const blocking = [];
  if (stored.error) blocking.push(stored.error);
  let project = null;
  let lines = [];
  if (!stored.error) {
    try {
      const record = runtime.readRecordedProject(stored.payload, cwd, stateDir);
      if (record.error) blocking.push(record.error);
      else project = projectSummary(record.project);
    } catch (error) {
      blocking.push(`could not read the recorded project: ${error.message}`);
    }
    try { lines = readOutcomeLines(stateDir); } catch (error) {
      blocking.push(`could not read worker outcome evidence: ${error.message}`);
    }
  }
  const outcomes = stored.id ? outcomeSummary(lines, stored.id) : null;
  const { tasks, unmatched } = joinVerdictsAll(project, outcomes?.tasks ?? []);
  if (!stored.error) blocking.push(...blockingReasons({ tests: { passed: true }, project, tasks }));
  if (project) {
    if (project.cancelledAt !== null) blocking.push('the project was cancelled');
    if (project.brief?.status !== 'approved' || project.plan?.status !== 'approved') blocking.push('the brief and plan must both be approved');
    if (project.gate === null || typeof project.gate.kind !== 'string') blocking.push('the project gate could not be read');
    for (const milestone of project.milestones) {
      if (!['done', 'reviewed'].includes(milestone.state)) blocking.push(`milestone ${milestone.id} remains ${milestone.state}`);
    }
    for (const task of tasks) {
      if (task.latest && task.latest.join !== 'key') blocking.push(`task ${task.taskId}: only an unkeyed outcome was found`);
      if (task.latest && task.latest.status !== 'ok') blocking.push(`task ${task.taskId}: latest execution status is ${task.latest.status}`);
    }
  }
  return {
    execution: {
      passed: blocking.length === 0,
      blocking,
      session: stored.error ? { id: session ?? null, error: stored.error } : { id: stored.id, status: stored.status, workingDir: stored.workingDir },
      project,
      tasks,
      unmatchedVerdicts: unmatched,
    },
    workerExecutions: workerEvidence(lines, stored.id, runtime.candidateWorkerRuns),
  };
}

export async function buildReport(args) {
  const cwd = resolve(args.cwd);
  const stateDir = resolve(args.stateDir || process.env.ATOMIC_AGENT_STATE_DIR || join(homedir(), '.atomic-agent'));
  const fixture = selectFixture(cwd, args.fixture);
  const runtime = await loadRuntime();
  const [artifact, { execution, workerExecutions }] = await Promise.all([
    inspectArtifact(cwd, fixture, runtime.runVerify),
    inspectExecution(cwd, stateDir, args.session, runtime),
  ]);
  const blocking = [
    ...('error' in artifact ? [artifact.error] : []),
    ...artifact.checks.filter(({ status }) => status !== 'pass').map(({ id, detail }) => `${id}: ${detail}`),
    ...(!artifact.passed && artifact.combined && artifact.checks.every(({ status }) => status === 'pass')
      ? [`combined artifact check: ${artifact.combined.detail}`] : []),
    ...execution.blocking,
  ];
  return { fixture, cwd, stateDir, recordedAt: new Date().toISOString(), passed: artifact.passed && execution.passed, blocking, artifact, execution, workerExecutions };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ('help' in args) { process.stdout.write(USAGE + '\n'); return 0; }
  if ('error' in args) { process.stderr.write(`${args.error}\n${USAGE}\n`); return 2; }
  const report = await buildReport(args);
  const text = JSON.stringify(report, null, 2) + '\n';
  if (args.output) {
    writeFileSync(args.output, text);
    process.stderr.write(`report: ${resolve(args.output)}\n`);
  } else process.stdout.write(text);
  return report.passed ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]);
const self = fileURLToPath(import.meta.url);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
