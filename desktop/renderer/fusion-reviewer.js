/* ---------------- Issue #71: the Fusion strip's Reviewer seat ----------------
   Loaded before renderer.js; declares only, and reads renderer.js globals
   (S, LIVE_CONFIG, BR, esc, ic, providerWord, render, act, toast, anchorStyle,
   refreshLiveConfig, projectCloudEntry) at call time.

   Fusion shows three seats: Director (the orchestrator leg), Worker (the
   worker leg) and Reviewer. The first two stay the legs, as before; when a
   team (`llm.runMode.fusion.team`) is configured each turn names their
   members (main/fusion-team.ts turnTeamFields). The Reviewer lists the
   team's reviewers from the agent (GET /api/fusion/team, IPC
   agent:fusionTeam): the ones this chat can use, the others disabled with
   the reason (its folder refuses the provider, or it cannot answer now),
   "No review", and "Add a reviewer…". The choice rides on the chat's next
   turn as `reviewer`; the agent stamps it on the chat and keeps it.

   "Add a reviewer…" lists the configured cloud providers (a Codex
   subscription first: it reviews read-only on the ChatGPT plan) and writes
   team.reviewers under the config lock (IPC agent:fusionTeamWrite),
   creating the team from the two seats when there is none. */

const FZR = {sid: null, asked: undefined, roster: null, token: 0, pending: {}, adding: false};
const FZR_NO_REVIEW = 'none';
const FZR_PROVIDER_MODEL = 'default';
const FZR_NEW_CHAT = '\u0000new';
const FZR_ADD_HINT = 'No cloud provider is set up to review. Add one in Settings › Models with Add provider: '
  + 'an OpenAI Codex (ChatGPT) or Claude Code subscription, or an API provider.';

function fzrWord(word, id) { return typeof word === 'function' ? word(id) : id; }

/** A member as a person reads it: the provider, and its model unless it is the provider's own. */
function fzrMemberLabel(ref, word) {
  const at = String(ref || '').indexOf(':');
  if (at <= 0) return String(ref || '');
  const id = ref.slice(0, at);
  const model = ref.slice(at + 1);
  return model === FZR_PROVIDER_MODEL ? fzrWord(word, id) : fzrWord(word, id) + ' · ' + model;
}

/** The choice the seat shows for the chat: one not sent yet, else the agent's stamp, else none (the team picks). */
function fzrChoice(roster, pending) {
  if (pending !== undefined && pending !== null) return pending;
  return roster && roster.chat ? roster.chat.reviewer : null;
}

/** The seat's chip word. */
function fzrSeatWord(roster, choice, word) {
  if (choice === FZR_NO_REVIEW) return 'No review';
  if (choice) return fzrMemberLabel(choice, word);
  const usable = roster && roster.configured ? roster.reviewers.filter((r) => r.usable) : [];
  return usable.length ? 'Team picks' : 'No reviewer';
}

/** The seat's rows: team picks, each reviewer (disabled with why when unusable), No review, Add a reviewer. */
function fzrRows(roster, choice, word) {
  const rows = [];
  const reviewers = roster && roster.configured ? roster.reviewers : [];
  if (!reviewers.length) {
    rows.push({kind:'empty', label:'No reviewers in the team', detail:'Add one to have every task checked'});
  } else {
    rows.push({kind:'auto', label:'Team picks', detail:'the strongest usable reviewer, another family first', active: !choice});
    for (const r of reviewers) {
      rows.push({kind:'member', ref:r.ref, label:fzrMemberLabel(r.ref, word),
        detail: r.usable ? 'reviews every task in this chat' : (r.why || 'not usable here'),
        disabled: !r.usable, active: choice === r.ref});
    }
    rows.push({kind:'none', label:'No review', detail:'tasks in this chat are not reviewed', active: choice === FZR_NO_REVIEW});
  }
  rows.push({kind:'add', label:'Add a reviewer…', detail:'a cloud provider or a Codex subscription'});
  return rows;
}

/** A provider entry's member ref: its model, or `default` (the entry's own) when it names none. */
function fzrEntryRef(p) {
  return p.id + ':' + (p.defaultChatModel || p.model || FZR_PROVIDER_MODEL);
}
function fzrIsCodex(p) {
  const cli = p && p.subscriptionCli && (typeof p.subscriptionCli === 'string' ? p.subscriptionCli : p.subscriptionCli.cli);
  return !!p && p.kind === 'subscription-cli' && cli === 'codex';
}
function fzrCloud(p) {
  if (typeof projectCloudEntry === 'function') return projectCloudEntry(p);
  return !!p && p.kind !== 'llama-server' && !p.baseUrl;
}

/** The configured cloud providers that are not reviewers yet, a Codex subscription first. */
function fzrCandidates(config, roster, word) {
  const providers = (config && config.llm && Array.isArray(config.llm.providers)) ? config.llm.providers : [];
  const listed = new Set(roster && roster.configured ? roster.reviewers.map((r) => r.ref) : []);
  const out = providers.filter((p) => p && p.id && fzrCloud(p)).map((p) => {
    const codex = fzrIsCodex(p);
    return {ref: fzrEntryRef(p), providerId: p.id, label: fzrWord(word, p.id), codex,
      detail: codex ? 'OpenAI on your ChatGPT subscription · runs read-only' : fzrMemberLabel(fzrEntryRef(p), (x) => x)};
  }).filter((c) => !listed.has(c.ref));
  return out.filter((c) => c.codex).concat(out.filter((c) => !c.codex));
}

/* ---- the seat in the window ---- */

function fzrKey() { return (typeof S !== 'undefined' && S.agentSession) || FZR_NEW_CHAT; }
function fzrRosterNow() {
  const sid = (typeof S !== 'undefined' && S.agentSession) || null;
  return FZR.sid === sid ? FZR.roster : null;
}
function fzrWordFn() { return typeof providerWord === 'function' ? providerWord : (id) => id; }

/** The Reviewer seat, after the Worker seat (renderer.js fzChipsHtml), Fusion only. */
function fzrSeatHTML() {
  const roster = fzrRosterNow();
  const sid = (typeof S !== 'undefined' && S.agentSession) || null;
  // Asked once per chat shown; a turn's end and a write ask again.
  if (roster === null && FZR.asked !== sid) void fzrRefresh(sid);
  // An agent without the team route (older than issue #71): no seat, as before.
  if (roster && roster.known === false) return '';
  const choice = fzrChoice(roster, FZR.pending[fzrKey()]);
  const word = fzrSeatWord(roster, choice, fzrWordFn());
  const open = typeof S !== 'undefined' && (S.overlay === 'fzr' || S.overlay === 'fzradd') ? ' is-open' : '';
  return '<span class="composer-seat" role="group" aria-label="Reviewer">'
    + '<button class="cchip reviewerchip' + open + '" data-act="fzr:open" data-id="' + esc(choice || '') + '"'
    + ' title="' + esc('Reviews the work: ' + word) + '" aria-label="' + esc('Reviews the work: ' + word) + '">'
    + ic('check') + '<span class="cval">' + esc(word) + '</span>' + ic('chevD', 'chev') + '</button></span>';
}

function fzrRowHTML(r, verb) {
  const dis = r.disabled || !verb;
  return '<button class="poprow' + (r.active ? ' on' : '') + (dis ? ' dim' : '') + '"'
    + (dis ? ' disabled' : ' data-act="' + esc(verb) + '"') + (r.detail ? ' title="' + esc(r.detail) + '"' : '') + '>'
    + '<span class="radio' + (r.active ? ' on' : '') + '"></span>'
    + '<span class="col"><span class="ml">' + esc(r.label) + '</span>'
    + (r.detail ? '<span class="cap">' + esc(r.detail) + '</span>' : '') + '</span></button>';
}

/** The seat's popover (renderer.js overlaysHTML): the rows, or the providers to add. */
function fzrPopoverHTML() {
  const word = fzrWordFn();
  const roster = fzrRosterNow();
  let body;
  if (S.overlay === 'fzradd') {
    const list = fzrCandidates(typeof LIVE_CONFIG !== 'undefined' ? LIVE_CONFIG : null, roster, word);
    body = '<div class="modehead"><span>Add a reviewer</span><span class="cap">written to the Fusion team</span></div>'
      + (list.length ? list.map((c) => fzrRowHTML({label: c.label, detail: c.detail}, FZR.adding ? '' : 'fzr:add:' + c.ref)).join('')
        : '<div class="modenote"><p class="ob-help">' + esc(FZR_ADD_HINT) + '</p>'
          + '<button class="btn btn-s sm" data-act="sel:addProvider">' + ic('plus') + 'Add provider</button></div>');
  } else {
    const choice = fzrChoice(roster, FZR.pending[fzrKey()]);
    const verb = (r) => r.kind === 'auto' ? 'fzr:pick:' : r.kind === 'member' ? 'fzr:pick:' + r.ref
      : r.kind === 'none' ? 'fzr:pick:' + FZR_NO_REVIEW : r.kind === 'add' ? 'fzr:addOpen' : '';
    body = '<div class="modehead"><span>Reviewer</span><span class="cap">checks each task before it counts as done</span></div>'
      + fzrRows(roster, choice, word).map((r) => fzrRowHTML(r, verb(r))).join('');
  }
  return '<div class="scrim" data-close="1" style="background:transparent">'
    + '<div class="popover modepop tk-pop fzrpop" style="width:360px;' + (typeof anchorStyle === 'function' ? anchorStyle('.reviewerchip', 360) : '') + '">'
    + body + '</div></div>';
}

/** `fzr:` verbs (renderer.js act). */
async function fzrAct(v) {
  if (v === 'open') { S.overlay = 'fzr'; render(); void fzrRefresh(S.agentSession || null); return; }
  if (v === 'addOpen') { S.overlay = 'fzradd'; render(); return; }
  if (v.startsWith('pick:')) {
    const ref = v.slice('pick:'.length);
    // "Team picks" sends nothing new: a chat that chose before keeps its stamp until it chooses again.
    if (ref) FZR.pending[fzrKey()] = ref; else delete FZR.pending[fzrKey()];
    S.overlay = null; render();
    return;
  }
  if (v.startsWith('add:')) {
    const ref = v.slice('add:'.length);
    if (!BR || !BR.fusionTeamWrite) return;
    FZR.adding = true; render();
    let res = null;
    try { res = await BR.fusionTeamWrite({op: 'addReviewer', ref}); } catch (e) { res = {ok: false, error: String(e)}; }
    FZR.adding = false;
    if (!res || !res.ok) { toast('Reviewer not added', (res && res.error) || 'the config write failed'); render(); return; }
    // The new reviewer is the chat's choice: that is why it was added from here.
    FZR.pending[fzrKey()] = ref;
    if (res.live === false) toast('Reviewer added', 'Restart the agent to use it: this agent cannot take config changes live.');
    S.overlay = null;
    if (typeof refreshLiveConfig === 'function') await refreshLiveConfig();
    await fzrRefresh(S.agentSession || null);
    render();
  }
}

/** The team choice a turn of the chat on screen carries (renderer.js BR.chat), or null. Used up by the send. */
function fzrTurnTeam(session) {
  const key = session || FZR_NEW_CHAT;
  const reviewer = FZR.pending[key];
  return reviewer ? {reviewer} : null;
}
/** The send went out: the choice is the agent's stamp now (a new chat's moves with it). */
function fzrTurnSent(session) { delete FZR.pending[session || FZR_NEW_CHAT]; }

/** Ask the agent for the team as chat `sid` can use it (on open, at a turn's end, after a write). */
async function fzrRefresh(sid) {
  if (typeof BR === 'undefined' || !BR || !BR.fusionTeam) return;
  const token = ++FZR.token;
  if (FZR.sid !== sid) FZR.roster = null;
  FZR.sid = sid; FZR.asked = sid;
  let roster = null;
  try { roster = await BR.fusionTeam(sid); } catch (e) { roster = null; }
  if (token !== FZR.token) return;
  FZR.roster = roster && roster.known ? roster : {known: false, configured: false, directors: [], workers: [], reviewers: [], review: null, chat: null};
  fzrRepaint();
}
function fzrRepaint() {
  const el = typeof document !== 'undefined' ? document.querySelector('#composer .cfoot .reviewerchip') : null;
  if (!el) return;
  const seat = el.closest('.composer-seat');
  if (seat && typeof chipSwap === 'function') chipSwap(seat, fzrSeatHTML());
  if (typeof S !== 'undefined' && (S.overlay === 'fzr' || S.overlay === 'fzradd') && typeof renderOverlays === 'function') renderOverlays();
}

/** A Fusion seat moved (renderer.js fzAfter): a team gets the new leg's member, so the seat leads. */
async function fzrLegsMoved() {
  const team = typeof LIVE_CONFIG !== 'undefined' && LIVE_CONFIG && LIVE_CONFIG.llm && LIVE_CONFIG.llm.runMode
    && LIVE_CONFIG.llm.runMode.fusion && LIVE_CONFIG.llm.runMode.fusion.team;
  if (!team || typeof BR === 'undefined' || !BR || !BR.fusionTeamWrite) return;
  try {
    const res = await BR.fusionTeamWrite({op: 'followLegs'});
    if (res && res.ok && res.changed && typeof refreshLiveConfig === 'function') await refreshLiveConfig();
  } catch (e) { /* the seat still runs as the team's default */ }
  await fzrRefresh((typeof S !== 'undefined' && S.agentSession) || null);
}

if (typeof module !== 'undefined') {
  module.exports = {fzrRows, fzrSeatWord, fzrCandidates, fzrChoice, fzrMemberLabel, fzrEntryRef, fzrTurnTeam, fzrTurnSent, FZR, FZR_ADD_HINT};
}
