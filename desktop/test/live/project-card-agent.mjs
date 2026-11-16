/**
 * project-card-agent.mjs: the agent for L16, an `atag` that is this
 * checkout's real agent with the fusion project routes stood in.
 *
 * The desktop runs it as ATOMIC_AGENT_BIN. Every command but `serve` runs
 * the real agent unchanged (the app's `config get`, `models …`). `serve`
 * starts the real `atag serve` on a port of its own and listens on the port
 * the app chose, passing every request through, except:
 *
 *   GET  /api/capabilities       the real answer with `agent.project: true`
 *   GET  /api/events             a held stream of `project_gate` frames
 *   GET  /api/project?session=   the stood-in gate view
 *   POST /api/project/decision   the gate's rules, as the runtime's
 *   POST /v1/chat/completions    passed through, recorded, and watched for
 *                                the chat's session id
 *
 * So the window, its chats and the turns are real (the scripted model
 * answers them), and the project moves only through the agent's own core
 * (built dist: applyProjectUpdate, applyProjectDecision, projectGateView,
 * estimatePlan, projectContinueMessage). Only what the director would have
 * written is scripted, by what the project expects after each turn: the
 * brief after the first, the plan after the brief's approval, a milestone
 * report after each continue. To exercise `409 stale-version`, the first
 * edit of the plan is followed by a silent re-draft (a version bump with no
 * frame). Every request it answers or watches is a JSON line in $PCO_LOG.
 *
 * Usage (from the shim L16 writes): node project-card-agent.mjs --pco-base=<run dir> <atag args…>
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const AGENT = process.env.PCO_AGENT_ENTRY;
const LOG = process.env.PCO_LOG;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--pco-base='));
/* The run directory on every child's command line: live-harness's sweep finds leftovers by it. */
const BASE = (process.argv.find((a) => a.startsWith('--pco-base=')) ?? '').slice('--pco-base='.length);
const NODE_FLAGS = ['--enable-source-maps', ...(BASE ? [`--diagnostic-dir=${BASE}`] : [])];

const log = (entry) => { if (LOG) appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n'); };


/* ------------------------------------------------------------- the views -- */
/* The project is the agent's own: its state moves only through the built
   core (applyProjectUpdate, applyProjectDecision), and the view, the gate's
   version and continue_message are the core's (projectGateView,
   estimatePlan, projectContinueMessage). Only what the director would have
   written (the brief, the plan, a milestone's report) is scripted here. */

const DIST = join(dirname(AGENT), '..');
const core = async (rel) => import(pathToFileURL(join(DIST, rel)).href);
const P = await core('session/session-project.js');
const { projectGateView } = await core('tools/fusion/project-gate-view.js');
const { estimatePlan } = await core('tools/fusion/project-estimate.js');
const { projectContinueMessage } = await core('session/project-continue.js');

const MILESTONES = [
  { id: 'm1', title: 'Board and pieces', kind: 'base' },
  { id: 'm2', title: 'Rules and moves', kind: 'logic' },
];
const SELECTABLE = {
  workers: ['openrouter:worker-fast', 'openrouter:worker-careful', 'local:worker-small'],
  reviewers: ['openrouter:reviewer-strict', 'openrouter:reviewer-quick'],
};
const BRIEF = { what: 'A chess game for two players on one computer', users: 'two people sharing a laptop', how: 'a single web page, no server',
  successCriteria: ['only legal moves are accepted', 'check and checkmate are announced'] };
const ROWS = [
  { taskId: 't1', title: 'Draw the board and the pieces', milestoneId: 'm1', worker: 'local:worker-small', reviewer: 'openrouter:reviewer-quick',
    reason: 'passed 4 of the last 5 layout tasks at the lowest cost', basis: 'measured', samples: 5, estCostUsd: 0, estMs: 140_000 },
  { taskId: 't2', title: 'Move pieces by drag and drop', milestoneId: 'm1', worker: 'local:worker-small', reviewer: null,
    reason: 'no runs measured yet; the preset puts small UI tasks on the local worker', basis: 'preset', samples: 0, estCostUsd: 0, estMs: 210_000 },
  { taskId: 't3', title: 'Legal moves, check and checkmate', milestoneId: 'm2', worker: 'openrouter:worker-careful', reviewer: 'openrouter:reviewer-strict',
    reason: 'rule engines failed twice on the fast worker; the careful one passed 3 of 3', basis: 'measured', samples: 3, estCostUsd: 0.41, estMs: 420_000 },
];
const SUMMARIES = ['The board renders with all 32 pieces; dragging snaps a piece to the nearest square.',
  'The board renders with bigger squares; dragging snaps a piece to the nearest square.'];
/* One local slot: two local tasks in m1 is the estimator's own warning. */
const estimate = (project) => (project?.plan ? estimatePlan(project.plan.rows, { isLocal: (w) => w.startsWith('local:'), localSlots: 1 }) : null);

let project;
let sessionId = null;
let now = Date.now();
let reports = 0;
const view = () => projectGateView({ sessionId, project, estimate: estimate(project), selectable: SELECTABLE });
const update = (u) => {
  const r = P.applyProjectUpdate(project, u, now++);
  if (!r.ok) throw new Error(`stand-in update refused: ${r.error.message}`);
  project = r.project;
};

/* ------------------------------------------------------------ the server -- */

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function serve() {
  const at = args.indexOf('--port');
  const outer = Number(args[at + 1]);
  const keyAt = args.indexOf('--api-key');
  const token = keyAt >= 0 ? args[keyAt + 1] : null;
  const inner = await freePort();
  const innerArgs = [...args];
  innerArgs[at + 1] = String(inner);
  const child = spawn(process.execPath, [...NODE_FLAGS, AGENT, ...innerArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { child.kill(sig); });
  child.on('exit', (code, signal) => { log({ type: 'serve-exit', code, signal }); process.exit(code ?? 0); });
  log({ type: 'serve', outer, inner });

  const streams = new Set();
  const open = () => project !== undefined && project.gate.kind !== 'none' && project.cancelledAt === undefined;
  const push = () => {
    if (!sessionId || project === undefined) return;
    const v = view();
    const frame = `event: project_gate\ndata: ${JSON.stringify({ session_id: sessionId, view: v })}\n\n`;
    for (const res of streams) res.write(frame);
    log({ type: 'pushed', gate: v.gate, version: v.version });
  };
  /* What the director would have written in the turn that just ended, by
     what the project expects next (projectExpectation). */
  const turnEnded = () => {
    if (!sessionId) return;
    const next = P.projectExpectation(project);
    if (project === undefined) update({ kind: 'brief', brief: BRIEF, draftedAfterUntrusted: false });
    else if (next.kind === 'draft_plan' && project.plan === undefined) {
      update({ kind: 'plan', milestones: MILESTONES, rows: ROWS, detail: 'full', draftedAfterUntrusted: true });
    } else if (next.kind === 'run_milestone') {
      update({ kind: 'milestone_run', id: next.id, runId: `run-${next.id}-${reports}` });
      update({ kind: 'milestone', id: next.id, state: 'done', summary: SUMMARIES[Math.min(reports, SUMMARIES.length - 1)] });
      reports += 1;
    } else return;
    push();
  };

  const authed = (req) => !token || req.headers.authorization === `Bearer ${token}`;
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });

  const pass = (req, res, body, onUpstream) => {
    const up = httpRequest({ host: '127.0.0.1', port: inner, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      if (onUpstream) return onUpstream(ur);
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', (e) => { if (!res.headersSent) json(res, 502, { error: { message: `stand-in: ${e.message}` } }); else res.destroy(); });
    // The response's close, not the request's: a request emits close once its body is read.
    res.on('close', () => { if (!res.writableEnded) up.destroy(); });
    if (body !== undefined) up.end(body); else req.pipe(up);
  };

  let reestimated = false;
  const decide = (body) => {
    if (project === undefined || body.session !== sessionId) return { status: 404, body: { error: { message: `no project on session ${body.session}` } } };
    const est = estimate(project);
    const r = P.applyProjectDecision(project, { gate: body.gate, version: body.version, verdict: body.verdict, ...(body.edits ? { edits: body.edits } : {}) },
      { now: now++, hardViolations: est?.hardViolations ?? [] });
    if (!r.ok) {
      const status = { 'no-project': 404, 'wrong-gate': 409, 'stale-version': 409, 'over-cap': 422, 'needs-estimates': 422 }[r.error.code] ?? 400;
      return { status, body: { error: { message: r.error.message, type: 'invalid_request_error', code: r.error.code }, view: view() } };
    }
    project = r.project;
    const v = view();
    const answer = { status: 200, body: { session_id: sessionId, view: v, continue_message: projectContinueMessage(v, body) } };
    if (body.verdict === 'edit' && body.gate.kind === 'plan' && !reestimated) {
      /* The director re-drafted the plan before the person answered (a plan
         update bumps its version). No frame: the next approve of the version
         on screen is stale, which is the 409 path. */
      reestimated = true;
      setTimeout(() => {
        update({ kind: 'plan', milestones: MILESTONES, rows: project.plan.rows, detail: 'full', draftedAfterUntrusted: true });
        log({ type: 're-estimated', version: view().version });
      }, 50);
    }
    return answer;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/capabilities' && req.method === 'GET') {
      return pass(req, res, undefined, (ur) => {
        let b = '';
        ur.on('data', (c) => { b += c; });
        ur.on('end', () => {
          try {
            const caps = JSON.parse(b);
            caps.agent = { ...caps.agent, project: true };
            log({ type: 'capabilities' });
            return json(res, ur.statusCode, caps);
          } catch {
            res.writeHead(ur.statusCode, ur.headers); res.end(b);
          }
        });
      });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (!authed(req)) return json(res, 401, { error: { message: 'unauthorized' } });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': stand-in events\n\n');
      streams.add(res);
      log({ type: 'events-open', streams: streams.size });
      // The open gate is replayed on connect, as the agent's bus does.
      if (sessionId && open()) res.write(`event: project_gate\ndata: ${JSON.stringify({ session_id: sessionId, view: view() })}\n\n`);
      const beat = setInterval(() => res.write(': keepalive\n\n'), 15000);
      res.on('close', () => { clearInterval(beat); streams.delete(res); });
      return;
    }
    if (url.pathname === '/api/project' && req.method === 'GET') {
      if (!authed(req)) return json(res, 401, { error: { message: 'unauthorized' } });
      const sid = url.searchParams.get('session');
      log({ type: 'project-read', session: sid });
      if (!sid || sid !== sessionId || project === undefined) return json(res, 404, { error: { message: `no project on session ${sid}` } });
      return json(res, 200, { session_id: sid, view: view() });
    }
    if (url.pathname === '/api/project/decision' && req.method === 'POST') {
      if (!authed(req)) return json(res, 401, { error: { message: 'unauthorized' } });
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: { message: 'Invalid JSON' } }); }
      const out = decide(body);
      log({ type: 'decision', body, status: out.status, code: out.body.error?.code ?? null, version: out.body.view?.version ?? null,
        continue_message: out.body.continue_message ?? null, gate: out.body.view?.gate ?? null });
      json(res, out.status, out.body);
      if (out.status === 200) push();
      return;
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch { /* the agent says so */ }
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
      log({ type: 'chat', project: req.headers['x-atomic-project'] ?? null, extensions: req.headers['x-atomic-extensions'] ?? null,
        session: body.session_id ?? null, text: typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? null) });
      return pass(req, res, raw, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        let buf = '';
        ur.on('data', (c) => {
          res.write(c);
          buf += c;
          const m = buf.match(/event: session_id\ndata: (\{[^\n]*\})/);
          if (m && !sessionId) {
            try { sessionId = JSON.parse(m[1]).session_id; log({ type: 'session', session: sessionId }); } catch { /* not yet whole */ }
          }
          if (buf.length > 65536) buf = buf.slice(-4096);
        });
        ur.on('end', () => {
          res.end();
          try { turnEnded(); } catch (e) { log({ type: 'stand-in-error', message: String(e && e.stack || e) }); }
        });
      });
    }
    return pass(req, res);
  });
  server.listen(outer, '127.0.0.1');
}

if (args[0] !== 'serve') {
  const child = spawn(process.execPath, [...NODE_FLAGS, AGENT, ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  await serve();
}
