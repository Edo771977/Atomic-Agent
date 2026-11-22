// The milestone card's evidence, as the TUI's project card shows it
// (src/tui/project/project-card-lines.ts, loaded here from the agent's own
// source): the receipts summary (issue #119). Every line the desktop draws
// is compared with the TUI's own line for the same view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadCore } from './core-ts.mjs';

const require = createRequire(import.meta.url);
const C = require('../renderer/project-card.js');
const EXTRA = ['node:url', 'node:vm', 'node:crypto'];
const TUI = loadCore(new URL('../../src/tui/project/project-card-lines.ts', import.meta.url), EXTRA);

/* ---------------- a milestone gate view, as the agent sends it ---------------- */

function view(m1 = {}, over = {}) {
  return Object.assign({
    schema: 1, sessionId: 'ses-1', gate: {kind: 'milestone', id: 'm1'}, version: 5,
    allowedVerdicts: ['approve', 'edit', 'cancel'],
    expectation: {kind: 'await_person', gate: {kind: 'milestone', id: 'm1'}}, cancelled: false,
    brief: {version: 1, what: 'A chess game', users: 'me', how: 'browser', successCriteria: ['Runs in a browser', 'Ten levels'],
      criteria: [{id: 'c1', text: 'Runs in a browser'}, {id: 'c2', text: 'Ten levels'}], status: 'approved', draftedAfterUntrusted: false},
    plan: {status: 'approved', detail: 'full', version: 2, draftedAfterUntrusted: false, rows: [], totals: {costUsd: 0.1, ms: 1000, unknownCostRows: 0}, editable: false},
    milestones: [
      Object.assign({id: 'm1', title: 'Base', kind: 'base', state: 'done', runIds: ['r1'], updatedAt: 2, estCostUsd: 0.1, estMs: 1000}, m1),
      {id: 'm2', title: 'Logic', kind: 'logic', state: 'approved', runIds: [], updatedAt: 1, estCostUsd: null, estMs: null},
    ],
    violations: [], hints: [],
  }, over);
}

/** The TUI card's text lines for a view (full, wide enough that nothing wraps). */
function tuiLines(v) {
  const card = {sessionId: 'ses-1', view: v, full: true, mode: 'actions', cursor: 0, row: 0, field: 'worker', picks: {}, note: '', scroll: 0, pending: false, error: null};
  return TUI.projectCardLines(card, 4000).map((l) => l.segments.map((s) => s.text).join('').trim()).filter(Boolean);
}

function fakeDoc() {
  const doc = {activeElement: null};
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this._text = ''; this.className = ''; this.hidden = false; }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
    get firstChild() { return this.children[0] || null; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set innerHTML(_v) { throw new Error('innerHTML used'); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    focus() { doc.activeElement = this; }
    contains(x) { for (let n = x; n; n = n.parentNode) if (n === this) return true; return false; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    findAll(pred) { const out = []; const walk = (e) => { if (pred(e)) out.push(e); e.children.forEach(walk); }; walk(this); return out; }
  }
  return Object.assign(doc, {createElement: (t) => new El(t)});
}
const draw = (v) => { const doc = fakeDoc(); const host = doc.createElement('div'); C.pcDraw(doc, host, C.pcModel(C.pcInitial(v)), () => {}); return host; };
const texts = (host, cls) => host.findAll((e) => new RegExp('\\b' + cls + '\\b').test(e.className)).map((e) => e.textContent);

/* ---------------- issue #119: the receipts summary ---------------- */

test('the milestone shows its receipts summary in one line, worded as the TUI card, with the verify hint and folder', () => {
  for (const [receipts, tone, hinted] of [
    [{folder: '/home/me/chess', valid: 3, unsigned: 0, problems: 0}, 'ok', false],
    [{folder: '/home/me/chess', valid: 2, unsigned: 1, problems: 0}, 'warn', true],
    [{folder: '/home/me/chess', valid: 1, unsigned: 0, problems: 2}, 'error', true],
    [{folder: '/home/me/chess', valid: 0, unsigned: 0, problems: 1}, 'error', true],
    [{folder: '/home/me/chess', valid: 4, unsigned: 0, problems: 0, partial: true}, 'warn', true],
    [{folder: '/home/me/chess', valid: 0, unsigned: 0, problems: 0, archiveUnavailable: true}, 'error', true],
    [{valid: 0, unsigned: 2, problems: 0}, 'warn', true],
    [{folder: '/home/me/$HOME "chess"', valid: 0, unsigned: 1, problems: 0}, 'warn', true],
    [{folder: 'C:\\Users\\me\\chess\\', valid: 0, unsigned: 1, problems: 0}, 'warn', true],
  ]) {
    const v = view({evidenceReceipts: receipts});
    const tui = tuiLines(v);
    const line = tui.find((l) => l.startsWith('Evidence: '));
    const hint = tui.find((l) => l.startsWith('Run atomic-agent project verify'));
    assert.ok(line, JSON.stringify(tui));
    const host = draw(v);
    const drawn = host.findAll((e) => /\bpc-evidence\b/.test(e.className));
    assert.deepEqual(drawn.map((e) => e.textContent), hinted ? [line, hint] : [line], JSON.stringify(receipts));
    assert.ok(drawn.every((e) => e.className.includes('is-' + tone)), tone + ' ' + JSON.stringify(receipts));
    assert.equal(hinted, hint !== undefined, 'the TUI hints the same cases');
  }
});

test('without receipts (an incognito chat, an older agent, another milestone) no evidence line is drawn', () => {
  assert.deepEqual(texts(draw(view()), 'pc-evidence'), []);
  assert.equal(tuiLines(view()).some((l) => l.startsWith('Evidence: ')), false);
  // Counts that are not numbers are not trusted.
  assert.deepEqual(texts(draw(view({evidenceReceipts: 'yes'})), 'pc-evidence'), []);
});

test('the evidence line is text: a folder with markup stays text', () => {
  const host = draw(view({evidenceReceipts: {folder: '/tmp/<img src=x onerror=alert(1)>', valid: 0, unsigned: 1, problems: 0}}));
  assert.match(texts(host, 'pc-evidence').join('\n'), /<img src=x onerror=alert\(1\)>/);
  assert.equal(host.findAll((e) => e.tagName === 'IMG').length, 0);
});
