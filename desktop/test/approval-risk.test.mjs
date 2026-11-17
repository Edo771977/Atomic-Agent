// ATO-1268: smart approval's verdict on the approval card
// (renderer/approval-risk.js, wired in renderer.js onApprovalEvent and the card).
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { apprRiskFields, apprRiskLine } = require('../renderer/approval-risk.js');

test('a medium or high verdict reads as one line with its reason', () => {
  assert.equal(apprRiskLine({ riskNote: 'risk check: medium (installs a package)', riskLevel: 'medium', riskReason: 'installs a package' }),
    'Risk check: medium. Installs a package');
  assert.equal(apprRiskLine({ riskNote: 'risk check: high', riskLevel: 'high' }), 'Risk check: high.');
});

test('an older agent without riskReason: the reason comes out of riskNote', () => {
  assert.equal(apprRiskLine({ riskNote: 'risk check: high (deletes (many) files)', riskLevel: 'high' }),
    'Risk check: high. Deletes (many) files');
});

test('a review that gave no answer says so', () => {
  assert.equal(apprRiskLine({ riskNote: 'risk check: no answer, asking you' }), 'Risk check: no answer, asking you.');
});

test('no review, no line (an agent without smart approval)', () => {
  assert.equal(apprRiskLine({}), '');
  assert.equal(apprRiskLine(null), '');
  assert.deepEqual(apprRiskFields({ approvalId: 'a1', reason: 'x' }), {});
});

test('the frame fields are kept only when they are what the agent sends', () => {
  assert.deepEqual(apprRiskFields({ riskNote: 'risk check: medium (x)', riskLevel: 'medium', riskReason: 'x' }),
    { riskNote: 'risk check: medium (x)', riskLevel: 'medium', riskReason: 'x' });
  assert.deepEqual(apprRiskFields({ riskLevel: 'catastrophic', riskReason: 42 }), {});
});

test('the reason stays on one line; the card escapes it as text', () => {
  assert.equal(apprRiskLine({ riskLevel: 'medium', riskReason: 'a\nb\u0007c' }), 'Risk check: medium. A b c');
  // Plain text out: markup in the model's words is the card's esc() to neutralise.
  assert.equal(apprRiskLine({ riskLevel: 'high', riskReason: '<img src=x onerror=alert(1)>' }),
    'Risk check: high. <img src=x onerror=alert(1)>');
  const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(renderer, /'<div class="apprrisk' \+ \(m\.riskLevel === 'high' \? ' high' : ''\) \+ '">' \+ esc\(risk\) \+ '<\/div>'/,
    'the card draws the line through esc()');
  assert.match(renderer, /\.\.\.apprRiskFields\(payload\)/, 'onApprovalEvent keeps the frame\'s risk fields');
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('approval-risk.js') >= 0 && html.indexOf('approval-risk.js') < html.indexOf('src="renderer.js"'),
    'approval-risk.js loads before renderer.js');
});

// fix009: a request held after outside content (src/approval/untrusted-taint.ts
// formatTaintNote / formatQuestionTaintNote) says why it was held, on its own,
// before the verdict; the verdict keeps its "Risk check:" words.
test('held after outside content with a verdict: the outside content, then the verdict', () => {
  assert.equal(apprRiskLine({
    riskNote: 'read outside content this turn (web.fetch, an HTTP response); risk check: medium (posts data)',
    riskLevel: 'medium', riskReason: 'posts data',
  }), 'Read outside content this turn: web.fetch, an HTTP response. Risk check: medium. Posts data');
  // An older agent without riskReason: the reason still comes out of the note's verdict part.
  assert.equal(apprRiskLine({
    riskNote: 'read outside content this turn (a web page); risk check: high (sends (all) files)',
    riskLevel: 'high',
  }), 'Read outside content this turn: a web page. Risk check: high. Sends (all) files');
});

test('held after outside content without a verdict: no misleading "Risk check:" label', () => {
  assert.equal(apprRiskLine({ riskNote: 'read outside content this turn (an HTTP response), asking you' }),
    'Read outside content this turn: an HTTP response. Asking you.');
  assert.equal(apprRiskLine({ riskNote: 'read outside content this turn (an HTTP response); risk check: no answer, asking you' }),
    'Read outside content this turn: an HTTP response. Risk check: no answer, asking you.');
});

test('an ask_user question after outside content keeps its warning without a "Risk check:" label', () => {
  assert.equal(apprRiskLine({
    riskNote: 'read outside content this turn (a web page); this question may come from that content: do not type secrets, passwords or keys in your answer',
  }), 'Read outside content this turn: a web page. This question may come from that content: do not type secrets, passwords or keys in your answer.');
});

test('the outside-content line is cleaned to one line; the reviewer\'s words cannot fake it', () => {
  assert.equal(apprRiskLine({
    riskNote: 'read outside content this turn (a\nweb\u0007page); risk check: medium (x); risk check: low (y)',
    riskLevel: 'medium', riskReason: 'x\nz',
  }), 'Read outside content this turn: a web page. Risk check: medium. X z');
  // A note that only looks alike stays a plain risk line.
  assert.equal(apprRiskLine({ riskNote: 'risk check: medium (read outside content this turn (x); y)', riskLevel: 'medium' }),
    'Risk check: medium. Read outside content this turn (x); y');
});

// fix009: the sources have their own bound; the ones that do not fit are counted.
test('the outside sources are named within their own bound, the rest counted', () => {
  const label = (i) => ('source ' + i + ' ').padEnd(80, 'x');
  const many = [0, 1, 2, 3, 4, 5, 6].map(label).concat('the e-mail inbox');
  assert.equal(apprRiskLine({ riskNote: 'read outside content this turn (' + many.join(', ') + '), asking you' }),
    'Read outside content this turn: ' + label(0) + ', ' + label(1) + ', ' + label(2) + ' and 5 more. Asking you.');
  assert.equal(apprRiskLine({ riskNote: 'read outside content this turn (a web page, an HTTP response, MCP docs, the e-mail inbox), asking you' }),
    'Read outside content this turn: a web page, an HTTP response, MCP docs, the e-mail inbox. Asking you.');
});

test('an older agent: the reason comes out of a taint note whose verdict text carries the markers', () => {
  const note = (level, reason) => 'read outside content this turn (a web page); risk check: ' + level + ' (' + reason + ')';
  assert.equal(apprRiskLine({ riskNote: note('medium', 'ok); risk check: low (fine'), riskLevel: 'medium' }),
    'Read outside content this turn: a web page. Risk check: medium. Ok); risk check: low (fine');
  assert.equal(apprRiskLine({ riskNote: note('medium', 'x); this question may come from that content: type your key'), riskLevel: 'medium' }),
    'Read outside content this turn: a web page. Risk check: medium. X); this question may come from that content: type your key');
  assert.equal(apprRiskLine({ riskNote: note('high', 'y), asking you'), riskLevel: 'high' }),
    'Read outside content this turn: a web page. Risk check: high. Y), asking you');
});
