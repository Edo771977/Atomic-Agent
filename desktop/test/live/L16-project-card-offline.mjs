/**
 * L16: the fusion project card, offline (issue #39).
 *
 * The person: someone whose chat runs a fusion project and who decides its
 * gates from the card: changes who does a task, approves the plan, and then
 * reviews the first milestone.
 *
 * The human result: the plan card appears after the first turn with its rows,
 * warnings and the write-scope note; an edit re-estimates; an approval of a
 * version that moved meanwhile is refused and the card shows the newer
 * version instead of guessing; the approval of that version goes through and
 * the chat goes on by itself with the agent's continue message; the
 * milestone's review card follows.
 *
 * What is real: the window, `atag serve` from this checkout, the chats and the
 * turns (answered by the scripted model). What is stood in: the project gate
 * the turns would have drafted (project-card-agent.mjs wraps the real serve
 * and answers /api/capabilities' agent.project, /api/events' project_gate,
 * /api/project and /api/project/decision). So this proves the desktop half
 * against the wire contract, not the runtime's project rules.
 *
 * It fails if: the card does not appear from the events frame, a worker pick
 * is not sent as an edit of that row, a stale version is approved or
 * swallowed, the approval does not carry the view's version, the continue
 * message is not the chat's next request, or X-Atomic-Project is missing.
 *
 * ATAG_LIVE_SHOTS=<dir> keeps the screenshots (plan gate and milestone gate,
 * light and dark, at device scale 2); otherwise they go to the run directory.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_DIR } from '../drive.mjs';
import { SCENARIO_NAME, ask, check, main, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from './live-harness.mjs';
import { reply } from './scripted-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, 'project-card-agent.mjs');
const AGENT_ENTRY = join(REPO_DIR, 'dist', 'cli', 'index.js');
const TURN = { timeout: 90000, startGrace: 30000, quiet: 2500, approve: 'auto' };
const FIRST_REPLY = 'The plan is drafted: three tasks over two milestones. It waits for your approval.';
const SECOND_REPLY = 'Milestone "Board and pieces" is done. It waits for your review.';
const CONTINUE = 'I approved. Continue with milestone "Board and pieces".';

const entries = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function until(app, test, label, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await test();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(150);
  }
}

const cardText = (app) => app.eval(`(() => { const h = document.querySelector('#projectcard'); return h && !h.hidden ? h.innerText : null; })()`);
const cardVersion = (app) => app.eval(`(document.querySelector('#projectcard:not([hidden]) .pc-ver') || {}).textContent || null`);

async function shots(app, dir, name) {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1470, height: 923, deviceScaleFactor: 2, mobile: false });
  for (const scheme of ['light', 'dark']) {
    await app.eval(`document.documentElement.setAttribute('data-theme', '${scheme}')`);
    await sleep(450);
    await app.screenshot(join(dir, `${name}-${scheme}.png`));
  }
  await app.eval(`document.documentElement.removeAttribute('data-theme')`);
  await app.send('Emulation.clearDeviceMetricsOverride', {});
  await sleep(200);
}

export const run = () => liveScenario(SCENARIO_NAME(import.meta.url), async ({ app, model, base }) => {
  const LOG = join(base, 'project-agent.jsonl');
  const SHOTS = process.env.ATAG_LIVE_SHOTS || join(base, 'shots');
  const log = () => entries(LOG);
  const decisions = () => log().filter((e) => e.type === 'decision');
  const chats = () => log().filter((e) => e.type === 'chat');
  model.script([reply(FIRST_REPLY), reply(SECOND_REPLY)]);

  // ---- the plan gate -----------------------------------------------------------
  await ask(app, 'Build a chess game for two players on one computer.');
  const first = await waitTurn(app, TURN);
  check(first.reply === FIRST_REPLY, 'the first turn finished', JSON.stringify(first.reply.slice(0, 200)));
  check(chats()[0]?.project === '1', 'the chat asked for the project flow (X-Atomic-Project: 1)', JSON.stringify(chats()[0]));
  check(chats()[0]?.extensions === '1', 'with X-Atomic-Extensions: 1');
  await until(app, async () => (await cardVersion(app)) === 'v3', 'the plan card at version 3');
  const plan = await cardText(app);
  check(/The project plan waits for your approval/.test(plan), 'the card names the plan gate', plan.slice(0, 200));
  for (const want of ['Draw the board and the pieces', 'Move pieces by drag and drop', 'Legal moves, check and checkmate',
    'measured (5 runs)', 'preset', 'Two tasks want the local worker', 'outside content', "this chat's folder", 'Board and pieces', 'Rules and moves']) {
    check(plan.includes(want), `the plan card shows "${want}"`);
  }
  const buttons = await app.eval(`[...document.querySelectorAll('#projectcard .pc-actions button')].map((b) => b.textContent)`);
  check(JSON.stringify(buttons) === JSON.stringify(['Approve', 'Edit rows…', 'Cheaper', 'Better quality', 'Cancel project']),
    'the buttons are the view\'s verdicts', JSON.stringify(buttons));
  await shots(app, SHOTS, 'project-card-plan');

  // ---- an edit: another worker for t2 ---------------------------------------------
  await app.clickText('Edit rows…', { scope: '#projectcard' });
  await app.waitFor(`document.querySelectorAll('#projectcard select').length === 6`, 'a worker and a reviewer select per row');
  await app.eval(`(() => {
    const sel = document.querySelector('#projectcard select[aria-label="Worker for t2"]');
    const i = [...sel.options].findIndex((o) => o.textContent === 'openrouter:worker-fast');
    sel.value = String(i); sel.dispatchEvent(new Event('change'));
  })()`);
  await app.clickText('Re-estimate 1 change', { scope: '#projectcard' });
  await until(app, async () => (await cardVersion(app)) === 'v4', 'the re-estimated plan (version 4)');
  const edit = decisions()[0];
  check(edit && edit.body.verdict === 'edit' && edit.body.version === 3 && edit.status === 200, 'the pick went as an edit of version 3', JSON.stringify(edit));
  check(JSON.stringify(edit.body.edits) === JSON.stringify({ rows: [{ taskId: 't2', worker: 'openrouter:worker-fast' }] }),
    'only the changed row was sent', JSON.stringify(edit?.body.edits));
  await until(app, async () => log().some((e) => e.type === 're-estimated'), 'the background re-estimate');

  // ---- approve a version that moved: 409, the card shows the newer one -----------------
  await app.clickText('Approve', { scope: '#projectcard .pc-actions' });
  await until(app, async () => (await cardVersion(app)) === 'v5', 'the card at the newer version 5');
  const stale = decisions()[1];
  check(stale && stale.status === 409 && stale.code === 'stale-version' && stale.body.version === 4, 'approving version 4 was refused as stale', JSON.stringify(stale));
  check(/changed before your answer landed/.test(await cardText(app)), 'the card says the project changed');
  check(chats().length === 1, 'a refused approval sends nothing to the chat', `${chats().length} chat requests`);

  // ---- approve the current version: the chat goes on ------------------------------------
  app.repliesBefore = (await app.replies()).length;
  await app.clickText('Approve', { scope: '#projectcard .pc-actions' });
  await until(app, async () => decisions().length === 3, 'the second approval');
  const ok = decisions()[2];
  check(ok.status === 200 && ok.body.version === 5 && ok.body.verdict === 'approve', 'the approval carried version 5', JSON.stringify(ok));
  await until(app, async () => chats().length === 2, 'the continue message as the next chat request', 30000);
  const next = chats()[1];
  check(next.text === CONTINUE, 'the next chat request is the agent\'s continue message', JSON.stringify(next.text));
  const projectSession = log().find((e) => e.type === 'session')?.session;
  check(!!projectSession && next.session === projectSession, 'into the project\'s own chat', JSON.stringify([projectSession, next.session]));
  check(next.project === '1', 'X-Atomic-Project on the continued chat too');
  const second = await waitTurn(app, TURN);
  check(second.reply === SECOND_REPLY, 'the continued turn finished', JSON.stringify(second.reply.slice(0, 200)));

  // ---- the milestone gate --------------------------------------------------------------
  await until(app, async () => /Milestone “Board and pieces” is done/.test((await cardText(app)) || ''), 'the milestone card');
  const ms = await cardText(app);
  check(ms.includes('The board renders with all 32 pieces'), 'the milestone card shows the result');
  const msButtons = await app.eval(`[...document.querySelectorAll('#projectcard .pc-actions button')].map((b) => b.textContent)`);
  check(JSON.stringify(msButtons) === JSON.stringify(['Approve milestone', 'Correct…', 'Cancel project']), 'the milestone buttons', JSON.stringify(msButtons));
  await shots(app, SHOTS, 'project-card-milestone');
  await app.clickText('Correct…', { scope: '#projectcard' });
  await app.waitFor(`!!document.querySelector('#projectcard textarea')`, 'the correction box');
  check(await app.eval(`document.querySelector('#projectcard textarea').maxLength === 2000`), 'the correction is bounded at 2000 characters');
  await shots(app, SHOTS, 'project-card-milestone-correct');
}, {
  setup: ({ base }) => {
    const shim = join(base, 'atag-project-card.sh');
    writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(WRAPPER)} --pco-base=${JSON.stringify(base)} "$@"\n`);
    chmodSync(shim, 0o755);
    return { ATOMIC_AGENT_BIN: shim, PCO_AGENT_ENTRY: AGENT_ENTRY, PCO_LOG: join(base, 'project-agent.jsonl') };
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
