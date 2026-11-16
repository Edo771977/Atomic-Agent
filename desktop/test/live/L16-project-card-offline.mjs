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
const BRIEF_REPLY = 'The brief is drafted. It waits for your approval.';
const THIRD_REPLY = 'Milestone "Board and pieces" is done again, with bigger squares.';
const NOTE = 'Make the squares bigger.';
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

/* Where the card is against the chat: a column beside it when wide, a sheet above the composer when narrow. */
async function geometry(app, label, { narrow = false } = {}) {
  const g = await app.eval(`(() => {
    const r = (q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return {l: b.left, t: b.top, r: b.right, b: b.bottom}; };
    return {card: r('#projectcard'), bar: r('#projectcard .pc-actions'), composer: r('.composerwrap'), list: r('#scroller'),
      vw: innerWidth, vh: innerHeight, narrow: document.querySelector('#projectcard').classList.contains('pc-narrow'),
      barClipped: [...document.querySelectorAll('#projectcard .pc-actions button')].some((b) => { const x = b.getBoundingClientRect(); const c = document.querySelector('#projectcard .pc-card').getBoundingClientRect(); return x.bottom > c.bottom + 0.5 || x.top < c.top - 0.5; })};
  })()`);
  const meets = (a, b) => !!a && !!b && a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5;
  check(g.narrow === narrow, `${label}: the card is ${narrow ? 'a sheet' : 'a column'}`, JSON.stringify(g));
  check(!meets(g.card, g.composer), `${label}: the card does not cover the composer`, JSON.stringify([g.card, g.composer]));
  if (!narrow) check(!meets(g.card, g.list), `${label}: the card does not cover the message list`, JSON.stringify([g.card, g.list]));
  check(g.bar && g.bar.b <= g.card.b + 0.5 && g.bar.t >= g.card.t && g.bar.b <= g.vh, `${label}: the action bar is inside the card and on screen`, JSON.stringify([g.bar, g.card, g.vh]));
  check(!g.barClipped, `${label}: every action button is fully visible`);
}

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
  const pushed = () => log().filter((e) => e.type === 'pushed');
  const lastPushed = () => pushed().at(-1);
  model.script([reply(BRIEF_REPLY), reply(FIRST_REPLY), reply(SECOND_REPLY), reply(THIRD_REPLY)]);
  /* Waits for the card at the version the agent last pushed for `kind`: the
     numbers are the agent's own (gateVersion), never assumed here. */
  const cardAt = async (kind, label) => {
    const p = await until(app, async () => { const e = lastPushed(); return e && e.gate.kind === kind ? e : null; }, `the agent's ${label}`);
    await until(app, async () => (await cardVersion(app)) === `v${p.version}`, `the ${label} card at v${p.version}`);
    return p.version;
  };
  const turn = async (want, label) => {
    const done = await waitTurn(app, TURN);
    check(done.reply === want, `${label} finished`, JSON.stringify(done.reply.slice(0, 200)));
  };
  const nextChat = async (n, text, label) => {
    await until(app, async () => chats().length === n, label, 30000);
    const c = chats()[n - 1];
    check(c.text === text, `${label}: the agent's continue message`, JSON.stringify(c.text));
    const projectSession = log().find((e) => e.type === 'session')?.session;
    check(!!projectSession && c.session === projectSession, `${label}: into the project's own chat`, JSON.stringify([projectSession, c.session]));
    check(c.project === '1', `${label}: X-Atomic-Project: 1`);
  };

  // ---- the brief gate ----------------------------------------------------------
  await ask(app, 'Build a chess game for two players on one computer.');
  await turn(BRIEF_REPLY, 'the first turn');
  check(chats()[0]?.project === '1', 'the chat asked for the project flow (X-Atomic-Project: 1)', JSON.stringify(chats()[0]));
  check(chats()[0]?.extensions === '1', 'with X-Atomic-Extensions: 1');
  const briefV = await cardAt('brief', 'brief');
  check(/The project brief waits for your approval/.test(await cardText(app)), 'the card names the brief gate');
  app.repliesBefore = (await app.replies()).length;
  await app.clickText('Approve', { scope: '#projectcard .pc-actions' });
  await until(app, async () => decisions().length === 1, 'the brief approval');
  check(decisions()[0].status === 200 && decisions()[0].body.version === briefV, `the brief approval carried v${briefV}`, JSON.stringify(decisions()[0]));
  await nextChat(2, decisions()[0].continue_message, 'after the brief');
  await turn(FIRST_REPLY, 'the plan turn');

  // ---- the plan gate (its own counter, from 1 again) --------------------------------
  const planV = await cardAt('plan', 'plan');
  const plan = await cardText(app);
  check(/The project plan waits for your approval/.test(plan), 'the card names the plan gate', plan.slice(0, 200));
  for (const want of ['Draw the board and the pieces', 'Move pieces by drag and drop', 'Legal moves, check and checkmate',
    'measured (5 runs)', 'preset', 'local', 'outside content', "this chat's folder", 'Board and pieces', 'Rules and moves']) {
    check(plan.includes(want), `the plan card shows "${want}"`);
  }
  check(await app.eval(`!!document.querySelector('#projectcard .pc-soft')`), 'the estimator\'s warning is drawn');
  const buttons = await app.eval(`[...document.querySelectorAll('#projectcard .pc-actions button')].map((b) => b.textContent)`);
  check(JSON.stringify(buttons) === JSON.stringify(['Approve', 'Edit rows…', 'Cheaper', 'Better quality', 'Cancel project']),
    'the buttons are the view\'s verdicts', JSON.stringify(buttons));
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1470, height: 923, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await geometry(app, 'wide window, plan gate');
  await app.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 760, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  await geometry(app, 'narrow window, plan gate', { narrow: true });
  await app.send('Emulation.setDeviceMetricsOverride', { width: 860, height: 760, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  await app.screenshot(join(SHOTS, 'project-card-plan-narrow-light.png'));
  await app.send('Emulation.clearDeviceMetricsOverride', {});
  await sleep(400);
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
  await until(app, async () => decisions().length === 2, 'the edit');
  const edit = decisions()[1];
  check(edit.body.verdict === 'edit' && edit.body.version === planV && edit.status === 200, `the pick went as an edit of v${planV}`, JSON.stringify(edit));
  check(JSON.stringify(edit.body.edits) === JSON.stringify({ rows: [{ taskId: 't2', worker: 'openrouter:worker-fast' }] }),
    'only the changed row was sent', JSON.stringify(edit.body.edits));
  await until(app, async () => (await cardVersion(app)) === `v${edit.version}`, `the re-estimated plan (v${edit.version})`);
  await until(app, async () => log().some((e) => e.type === 're-estimated'), 'the silent re-draft');
  const newer = log().find((e) => e.type === 're-estimated').version;

  // ---- approve a version that moved: 409, the card shows the newer one -----------------
  await app.clickText('Approve', { scope: '#projectcard .pc-actions' });
  await until(app, async () => (await cardVersion(app)) === `v${newer}`, `the card at the newer v${newer}`);
  const stale = decisions()[2];
  check(stale.status === 409 && stale.code === 'stale-version' && stale.body.version === edit.version, `approving v${edit.version} was refused as stale`, JSON.stringify(stale));
  check(/changed before your answer landed/.test(await cardText(app)), 'the card says the project changed');
  check(chats().length === 2, 'a refused approval sends nothing to the chat', `${chats().length} chat requests`);

  // ---- approve the current version: the chat goes on ------------------------------------
  app.repliesBefore = (await app.replies()).length;
  await app.clickText('Approve', { scope: '#projectcard .pc-actions' });
  await until(app, async () => decisions().length === 4, 'the second approval');
  const ok = decisions()[3];
  check(ok.status === 200 && ok.body.version === newer && ok.body.verdict === 'approve', `the approval carried v${newer}`, JSON.stringify(ok));
  check(ok.continue_message === CONTINUE, 'the agent\'s continue message names the milestone', JSON.stringify(ok.continue_message));
  await nextChat(3, CONTINUE, 'after the plan');
  await turn(SECOND_REPLY, 'the milestone turn');

  // ---- the milestone gate --------------------------------------------------------------
  const msV = await cardAt('milestone', 'milestone');
  const ms = await cardText(app);
  check(/Milestone “Board and pieces” is done/.test(ms), 'the milestone card');
  check(ms.includes('The board renders with all 32 pieces'), 'the milestone card shows the result');
  const msButtons = await app.eval(`[...document.querySelectorAll('#projectcard .pc-actions button')].map((b) => b.textContent)`);
  check(JSON.stringify(msButtons) === JSON.stringify(['Approve milestone', 'Correct…', 'Cancel project']), 'the milestone buttons', JSON.stringify(msButtons));
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1470, height: 923, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await geometry(app, 'wide window, milestone gate');
  await app.send('Emulation.clearDeviceMetricsOverride', {});
  await shots(app, SHOTS, 'project-card-milestone');
  await app.clickText('Correct…', { scope: '#projectcard' });
  await app.waitFor(`!!document.querySelector('#projectcard textarea')`, 'the correction box');
  check(await app.eval(`document.querySelector('#projectcard textarea').maxLength === 2000`), 'the correction is bounded at 2000 characters');
  await app.clickSel('#projectcard textarea');
  await app.type(NOTE, { perChar: 1 });
  await shots(app, SHOTS, 'project-card-milestone-correct');

  // ---- the correction: the same milestone's review comes back ------------------------------
  app.repliesBefore = (await app.replies()).length;
  await app.clickText('Send correction', { scope: '#projectcard' });
  await until(app, async () => decisions().length === 5, 'the correction');
  const fix = decisions()[4];
  check(fix.status === 200 && fix.body.version === msV && JSON.stringify(fix.body.edits) === JSON.stringify({ note: NOTE }), 'the correction carried the note', JSON.stringify(fix));
  await nextChat(4, fix.continue_message, 'after the correction');
  check(/My correction: Make the squares bigger/.test(chats()[3].text), 'the redo names the correction', JSON.stringify(chats()[3].text));
  await turn(THIRD_REPLY, 'the redo turn');
  await cardAt('milestone', 'milestone again');
  check((await cardText(app)).includes('bigger squares'), 'the reopened milestone card shows the new result');
}, {
  setup: ({ base }) => {
    const shim = join(base, 'atag-project-card.sh');
    writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(WRAPPER)} --pco-base=${JSON.stringify(base)} "$@"\n`);
    chmodSync(shim, 0o755);
    return { ATOMIC_AGENT_BIN: shim, PCO_AGENT_ENTRY: AGENT_ENTRY, PCO_LOG: join(base, 'project-agent.jsonl') };
  },
});

if (import.meta.url === `file://${process.argv[1]}`) main(run());
