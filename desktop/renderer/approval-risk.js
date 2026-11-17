/* ATO-1268: smart approval's verdict on the approval card.
   When the agent's risk review rated a request medium or high (or gave no
   answer), its `approval_request` frame carries `riskNote`, `riskLevel` and,
   from this version, `riskReason`. The card says it in one line:
   "Risk check: medium. Installs a package". The same words as the TUI,
   Telegram and Discord (src/approval/risk-review.ts formatRiskLine).
   An older agent sends no `riskReason`: the reason is read out of `riskNote`
   ("risk check: medium (installs a package)"). An agent without smart
   approval sends none of them, and the card has no line.
   A request held after outside content (agent.taintReview) or an ask_user
   question asked after it carries the taint note of
   src/approval/untrusted-taint.ts; the line then starts with its own
   sentence, "Read outside content this turn: <sources>.", before the
   verdict, so the person learns why it was held.
   Loaded before renderer.js; declares only. Returns plain text: the card
   escapes it (esc) like every other string from the agent.
   Shared by the renderer and the Node checks (test/approval-risk.test.mjs). */

const APPR_RISK_LEVELS = ['low', 'medium', 'high'];
const APPR_RISK_MAX = 160;

/** One line, no control characters, bounded (risk-review.ts sanitizeRiskReason). */
function apprRiskClean(raw) {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > APPR_RISK_MAX ? flat.slice(0, APPR_RISK_MAX - 1).trimEnd() + '…' : flat;
}

/** The risk fields of an `approval_request` frame, kept on the card's row. */
function apprRiskFields(payload) {
  const p = payload || {};
  const out = {};
  if (typeof p.riskNote === 'string' && p.riskNote.trim()) out.riskNote = p.riskNote;
  if (APPR_RISK_LEVELS.includes(p.riskLevel)) out.riskLevel = p.riskLevel;
  if (typeof p.riskReason === 'string' && p.riskReason.trim()) out.riskReason = p.riskReason;
  return out;
}

const APPR_TAINT_HEAD = 'read outside content this turn (';
const APPR_TAINT_QUESTION = 'this question may come from that content';

/* A request held after outside content (src/approval/untrusted-taint.ts):
   "read outside content this turn (<sources>), asking you" (no review),
   "read outside content this turn (<sources>); risk check: …" (reviewed),
   "read outside content this turn (<sources>); this question may come from
   that content: …" (an ask_user question). Split at the FIRST marker: the
   sources come from the agent's own labels, the text after them may carry
   the reviewer's words. Returns {sources, rest} (rest '' for "asking you"),
   or null for any other note. */
function apprTaintSplit(note) {
  if (note.slice(0, APPR_TAINT_HEAD.length).toLowerCase() !== APPR_TAINT_HEAD) return null;
  const body = note.slice(APPR_TAINT_HEAD.length);
  const lower = body.toLowerCase();
  const marks = ['); risk check:', '); ' + APPR_TAINT_QUESTION]
    .map((k) => lower.indexOf(k)).filter((i) => i >= 0);
  if (marks.length) {
    const at = Math.min(...marks);
    return {sources: body.slice(0, at), rest: body.slice(at + 3).trim()};
  }
  if (lower.endsWith('), asking you')) return {sources: body.slice(0, -'), asking you'.length), rest: ''};
  return null;
}

function apprSentence(text) {
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?…]$/.test(text) ? '' : '.');
}

/** The verdict alone: "Risk check: medium. Installs a package", or '' when no review ran. */
function apprVerdictLine(r, note) {
  if (APPR_RISK_LEVELS.includes(r.riskLevel)) {
    let reason = typeof r.riskReason === 'string' ? r.riskReason : '';
    if (!reason) {
      const parsed = /^risk check: [a-z]+ \((.*)\)$/i.exec(note);
      if (parsed) reason = parsed[1] || '';
    }
    reason = apprRiskClean(reason);
    return reason
      ? 'Risk check: ' + r.riskLevel + '. ' + reason.charAt(0).toUpperCase() + reason.slice(1)
      : 'Risk check: ' + r.riskLevel + '.';
  }
  if (!note) return '';
  const body = apprRiskClean(note.replace(/^risk check:\s*/i, ''));
  if (!body) return '';
  return 'Risk check: ' + body + (/[.!?…]$/.test(body) ? '' : '.');
}

/** "Risk check: medium. Installs a package", or '' when no review ran. Plain text.
    A request held after outside content first says so in its own sentence,
    "Read outside content this turn: web.fetch. ", then the verdict
    ("Risk check: …"), the question's warning, or "Asking you.". */
function apprRiskLine(m) {
  const r = m || {};
  const note = typeof r.riskNote === 'string' ? r.riskNote.trim() : '';
  const taint = apprTaintSplit(note);
  if (!taint) return apprVerdictLine(r, note);
  const sources = apprRiskClean(taint.sources) || 'an outside source';
  const head = 'Read outside content this turn: ' + sources + (/[.!?…]$/.test(sources) ? '' : '.');
  let tail;
  if (taint.rest.toLowerCase().startsWith(APPR_TAINT_QUESTION)) tail = apprSentence(apprRiskClean(taint.rest));
  else tail = apprVerdictLine(r, taint.rest) || 'Asking you.';
  return head + ' ' + tail;
}

if (typeof module !== 'undefined') module.exports = {apprRiskFields, apprRiskLine, apprRiskClean};
