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
 * answers them), and only the project the turns would have drafted is
 * scripted: after the chat's first turn the plan gate opens (version 3);
 * after the turn that the approval's continue_message starts, milestone
 * m1's review gate opens. A decision moves the gate as projectDecision
 * would: a version that is not the current one is `409 stale-version`
 * with the current view, an edit re-estimates the rows and, to exercise
 * that refusal, the plan is re-estimated once more in the background
 * (version 5) without a frame. Every request it answers or watches is a
 * JSON line in $PCO_LOG.
 *
 * Usage (from the shim L16 writes): node project-card-agent.mjs --pco-base=<run dir> <atag args…>
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';

const AGENT = process.env.PCO_AGENT_ENTRY;
const LOG = process.env.PCO_LOG;
const args = process.argv.slice(2).filter((a) => !a.startsWith('--pco-base='));
/* The run directory on every child's command line: live-harness's sweep finds leftovers by it. */
const BASE = (process.argv.find((a) => a.startsWith('--pco-base=')) ?? '').slice('--pco-base='.length);
const NODE_FLAGS = ['--enable-source-maps', ...(BASE ? [`--diagnostic-dir=${BASE}`] : [])];

const log = (entry) => { if (LOG) appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n'); };

if (args[0] !== 'serve') {
  const child = spawn(process.execPath, [...NODE_FLAGS, AGENT, ...args], { stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  await serve();
}

/* ------------------------------------------------------------- the views -- */

const MILESTONES = [
  { id: 'm1', title: 'Board and pieces', kind: 'base' },
  { id: 'm2', title: 'Rules and moves', kind: 'logic' },
];
const MEMBERS = {
  workers: ['openrouter:worker-fast', 'openrouter:worker-careful', 'local:worker-small'],
  reviewers: ['openrouter:reviewer-strict', 'openrouter:reviewer-quick'],
};
const START_ROWS = [
  { taskId: 't1', title: 'Draw the board and the pieces', milestoneId: 'm1', worker: 'openrouter:worker-fast', reviewer: 'openrouter:reviewer-quick',
    reason: 'passed 4 of the last 5 layout tasks at the lowest cost', basis: 'measured', samples: 5, estCostUsd: 0.08, estMs: 140_000 },
  { taskId: 't2', title: 'Move pieces by drag and drop', milestoneId: 'm1', worker: 'local:worker-small', reviewer: null,
    reason: 'no runs measured yet; the preset puts small UI tasks on the local worker', basis: 'preset', samples: 0, estCostUsd: 0, estMs: 210_000 },
  { taskId: 't3', title: 'Legal moves, check and checkmate', milestoneId: 'm2', worker: 'openrouter:worker-careful', reviewer: 'openrouter:reviewer-strict',
    reason: 'rule engines failed twice on the fast worker; the careful one passed 3 of 3', basis: 'measured', samples: 3, estCostUsd: 0.41, estMs: 420_000 },
];
const COST = { 'openrouter:worker-fast': 0.08, 'openrouter:worker-careful': 0.41, 'local:worker-small': 0 };

const project = { sessionId: null, gate: { kind: 'none' }, version: 2, rows: structuredClone(START_ROWS), states: { m1: 'planned', m2: 'planned' },
  summary: null, cancelled: false, expectation: { kind: 'draft_plan' } };

function totals(rows) {
  let cost = 0, ms = 0;
  for (const r of rows) { cost += r.estCostUsd ?? 0; ms += r.estMs ?? 0; }
  return { costUsd: Math.round(cost * 100) / 100, ms, unknownCostRows: rows.filter((r) => r.estCostUsd === null).length };
}

function view() {
  const open = project.gate.kind !== 'none' && !project.cancelled;
  const rows = project.rows.map((r) => ({ ...r, selectableWorkers: MEMBERS.workers, selectableReviewers: MEMBERS.reviewers }));
  const t = totals(project.rows);
  return {
    schema: 1, sessionId: project.sessionId, gate: project.gate, version: open ? project.version : null,
    allowedVerdicts: project.cancelled ? [] : project.gate.kind === 'plan' ? ['approve', 'edit', 'cheaper', 'quality', 'cancel']
      : project.gate.kind === 'milestone' ? ['approve', 'edit', 'cancel'] : ['cancel'],
    expectation: open ? { kind: 'await_person', gate: project.gate } : project.expectation,
    cancelled: project.cancelled,
    brief: { version: 1, what: 'A chess game for two players on one computer', users: 'two people sharing a laptop', how: 'a single web page, no server',
      successCriteria: ['only legal moves are accepted', 'check and checkmate are announced'], status: 'approved', draftedAfterUntrusted: false },
    plan: { status: project.gate.kind === 'plan' ? 'draft' : 'approved', detail: 'full', version: project.version, draftedAfterUntrusted: true, rows, totals: t },
    milestones: MILESTONES.map((m) => {
      const mine = project.rows.filter((r) => r.milestoneId === m.id);
      const mt = totals(mine);
      return { ...m, state: project.states[m.id], runIds: project.states[m.id] === 'planned' ? [] : [`run-${m.id}`],
        ...(m.id === 'm1' && project.summary ? { summary: project.summary } : {}), updatedAt: Date.now(), estCostUsd: mt.costUsd, estMs: mt.ms };
    }),
    violations: project.gate.kind === 'plan'
      ? [{ kind: 'local-slots', severity: 'warn', message: 'Two tasks want the local worker at once; the second waits for the first', taskId: 't2' }]
      : [],
  };
}

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
  const push = () => {
    if (!project.sessionId) return;
    const frame = `event: project_gate\ndata: ${JSON.stringify({ session_id: project.sessionId, view: view() })}\n\n`;
    for (const res of streams) res.write(frame);
    log({ type: 'pushed', gate: project.gate, version: view().version });
  };
  let turns = 0;
  const turnEnded = () => {
    turns += 1;
    if (turns === 1) { project.gate = { kind: 'plan' }; project.version = 3; push(); }
    else if (project.expectation.kind === 'run_milestone' && project.states.m1 === 'approved') {
      project.states.m1 = 'done';
      project.summary = 'The board renders with all 32 pieces; dragging snaps a piece to the nearest square.';
      project.gate = { kind: 'milestone', id: 'm1' };
      project.version += 1;
      push();
    }
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

  const decide = (body) => {
    const v = view();
    const err = (status, code, message) => ({ status, body: { error: { message, type: 'invalid_request_error', code }, view: v } });
    if (body.session !== project.sessionId) return { status: 404, body: { error: { message: `no project on session ${body.session}` } } };
    if (JSON.stringify(body.gate) !== JSON.stringify(project.gate)) return err(409, 'wrong-gate', 'that gate is not the one waiting');
    if (body.version !== v.version) return err(409, 'stale-version', `the gate is at version ${v.version}, not ${body.version}`);
    if (!v.allowedVerdicts.includes(body.verdict)) return err(400, 'verdict-not-allowed', `this gate takes ${v.allowedVerdicts.join(', ')}`);
    if (body.verdict === 'cancel') {
      project.cancelled = true; project.gate = { kind: 'none' }; project.expectation = { kind: 'cancelled' };
      return { status: 200, body: { session_id: project.sessionId, view: view(), continue_message: null } };
    }
    if (project.gate.kind === 'plan') {
      if (body.verdict === 'approve') {
        project.states.m1 = 'approved'; project.gate = { kind: 'none' }; project.expectation = { kind: 'run_milestone', id: 'm1' };
        return { status: 200, body: { session_id: project.sessionId, view: view(), continue_message: `I approved. Continue with milestone "${MILESTONES[0].title}".` } };
      }
      for (const e of body.edits?.rows ?? []) {
        const row = project.rows.find((r) => r.taskId === e.taskId);
        if (!row) return err(400, 'invalid', `no task ${e.taskId}`);
        if (e.worker !== undefined) { row.worker = e.worker; row.estCostUsd = COST[e.worker] ?? null; row.basis = 'preset'; row.samples = 0; row.reason = 'picked by you'; }
        if (e.reviewer !== undefined) { row.reviewer = e.reviewer; row.reviewerByPerson = true; }
      }
      project.version += 1;
      const answer = { status: 200, body: { session_id: project.sessionId, view: view(), continue_message: null } };
      // The live estimates moved again before the person answered: the next approve of this version is stale.
      setTimeout(() => { project.version += 1; project.rows[0].estMs += 20_000; log({ type: 're-estimated', version: project.version }); }, 50);
      return answer;
    }
    if (project.gate.kind === 'milestone') {
      if (body.verdict === 'approve') {
        project.states.m1 = 'reviewed'; project.states.m2 = 'approved'; project.gate = { kind: 'none' }; project.expectation = { kind: 'run_milestone', id: 'm2' };
        return { status: 200, body: { session_id: project.sessionId, view: view(), continue_message: `I approved. Continue with milestone "${MILESTONES[1].title}".` } };
      }
      project.states.m1 = 'approved'; project.gate = { kind: 'none' }; project.expectation = { kind: 'run_milestone', id: 'm1' };
      return { status: 200, body: { session_id: project.sessionId, view: view(), continue_message: `Redo milestone "${MILESTONES[0].title}". My correction: ${body.edits?.note ?? ''}` } };
    }
    return err(409, 'wrong-gate', 'nothing waits');
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
      if (project.sessionId && view().version !== null) res.write(`event: project_gate\ndata: ${JSON.stringify({ session_id: project.sessionId, view: view() })}\n\n`);
      const beat = setInterval(() => res.write(': keepalive\n\n'), 15000);
      res.on('close', () => { clearInterval(beat); streams.delete(res); });
      return;
    }
    if (url.pathname === '/api/project' && req.method === 'GET') {
      if (!authed(req)) return json(res, 401, { error: { message: 'unauthorized' } });
      const sid = url.searchParams.get('session');
      log({ type: 'project-read', session: sid });
      if (!sid || sid !== project.sessionId) return json(res, 404, { error: { message: `no project on session ${sid}` } });
      return json(res, 200, { session_id: sid, view: view() });
    }
    if (url.pathname === '/api/project/decision' && req.method === 'POST') {
      if (!authed(req)) return json(res, 401, { error: { message: 'unauthorized' } });
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: { message: 'Invalid JSON' } }); }
      const out = decide(body);
      log({ type: 'decision', body, status: out.status, code: out.body.error?.code ?? null, version: out.body.view?.version ?? null,
        continue_message: out.body.continue_message ?? null });
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
          if (m && !project.sessionId) {
            try { project.sessionId = JSON.parse(m[1]).session_id; log({ type: 'session', session: project.sessionId }); } catch { /* not yet whole */ }
          }
          if (buf.length > 65536) buf = buf.slice(-4096);
        });
        ur.on('end', () => { res.end(); turnEnded(); });
      });
    }
    return pass(req, res);
  });
  server.listen(outer, '127.0.0.1');
}
