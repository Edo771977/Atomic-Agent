/* ---------------- Issue #71: the Fusion strip's Reviewer seat ----------------
   Loaded before renderer.js; declares only, and reads renderer.js globals
   (S, LIVE_CONFIG, BR, esc, ic, providerWord, render, act, toast, anchorStyle,
   refreshLiveConfig, projectCloudEntry, screenTurnId, FIRST_TURNS, chatById) at call time.

   Fusion shows three seats: Director (the orchestrator leg), Worker (the
   worker leg) and Reviewer. The first two stay the legs, as before; when a
   team (`llm.runMode.fusion.team`) is configured each turn names their
   members (main/fusion-team.ts turnTeamFields). The Reviewer lists the
   team's reviewers from the agent (GET /api/fusion/team, IPC
   agent:fusionTeam): the ones this chat can use, the others disabled with
   the reason (its folder refuses the provider, or it cannot answer now),
   "No review", and "Add a reviewer…" (asked again when a new agent
   connects, issue #74). The choice rides on the chat's next
   turn as `reviewer`; the agent stamps it on the chat and keeps it. A new
   chat's pick goes with its first turn (FZR.byTurn) and becomes the chat's
   when that turn's stream names it, never another chat's (issue #74).

   "Add a reviewer…" lists the configured cloud providers (a Codex
   subscription first: it reviews read-only on the ChatGPT plan) and writes
   team.reviewers under the config lock (IPC agent:fusionTeamWrite),
   creating the team from the two seats when there is none. */

/* `byTurn`: a new chat's pick, sent with its first turn, by that turn's id until
   the turn's session_id frame names the chat (fzrTurnNamed; issue #74). */
/* `adds`: the chats "Add a reviewer…" writes are in flight for, each `{key, turn}`
   read when the write started (issue #77): a new chat's follows it as it gets
   an id or its first turn leaves (fzrAdoptNewChat, fzrTurnSent, fzrTurnNamed). */
const FZR = {sid: null, asked: undefined, roster: null, token: 0, pending: {}, note: {}, byTurn: {}, adding: false, gen: null, adds: [], popFor: null, dispatch: 0, newDispatch: null, screen: 0, newDispatchScreen: null};
const FZR_NO_REVIEW = 'none';
/* Sent to clear the chat's stamp: the team picks again (issue #71). */
const FZR_TEAM_PICKS = 'team';
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
  if (pending === FZR_TEAM_PICKS) return null;
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

/**
 * A provider entry's member ref: its model; `default` (the entry's own) for
 * a subscription CLI that names none; null for an API entry with none, which
 * must name one (it is priced and tiered by it).
 */
function fzrEntryRef(p) {
  const model = p.defaultChatModel || p.model || (p.kind === 'subscription-cli' ? FZR_PROVIDER_MODEL : '');
  return model ? p.id + ':' + model : null;
}
function fzrIsCodex(p) {
  const cli = p && p.subscriptionCli && (typeof p.subscriptionCli === 'string' ? p.subscriptionCli : p.subscriptionCli.cli);
  return !!p && p.kind === 'subscription-cli' && cli === 'codex';
}
function fzrCloud(p) {
  if (typeof projectCloudEntry === 'function') return projectCloudEntry(p);
  if (!p || p.kind === 'llama-server') return false;
  const url = p.baseUrl || p.url;
  if (!url) return true;
  try { return !/^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1)/.test(new URL(url).hostname); } catch (e) { return false; }
}

/** The configured cloud providers that are not reviewers yet, a Codex subscription first. */
function fzrCandidates(config, roster, word) {
  const providers = (config && config.llm && Array.isArray(config.llm.providers)) ? config.llm.providers : [];
  const listed = new Set(roster && roster.configured ? roster.reviewers.map((r) => r.ref) : []);
  const out = providers.filter((p) => p && p.id && fzrCloud(p)).map((p) => {
    const codex = fzrIsCodex(p);
    const ref = fzrEntryRef(p);
    if (ref === null) {
      return {ref: null, providerId: p.id, label: fzrWord(word, p.id), codex, disabled: true,
        detail: 'no model: pick a model for it in Settings › Models first'};
    }
    return {ref, providerId: p.id, label: fzrWord(word, p.id), codex,
      detail: codex ? 'OpenAI on your ChatGPT subscription · runs read-only' : fzrMemberLabel(ref, (x) => x)};
  }).filter((c) => c.ref === null || !listed.has(c.ref));
  return out.filter((c) => c.codex).concat(out.filter((c) => !c.codex));
}

/* ---- the seat in the window ---- */

/* Issue #74: the roster is the agent's that answered. A new agent
   (renderer.js AGENT_GEN: a restart, a switch to a remote agent) drops it,
   and a pending ask's answer, and the seat asks again; the picks not sent
   yet stay (they are the person's), the old agent's refusal words go. */
function fzrAgentSeen() {
  const gen = typeof AGENT_GEN === 'number' ? AGENT_GEN : 0;
  if (FZR.gen === gen) return false;
  const first = FZR.gen === null;
  FZR.gen = gen;
  if (first) return false;
  FZR.roster = null; FZR.sid = null; FZR.asked = undefined; FZR.token++; FZR.note = {};
  return true;
}
/** A new agent is up (renderer.js applyStatus): the seat asks it for the chat on screen. */
function fzrAgentChanged() {
  fzrAgentSeen();
  fzrScreenChanged();
  void fzrRefresh((typeof S !== 'undefined' && S.agentSession) || null);
}

function fzrKey() { return (typeof S !== 'undefined' && S.agentSession) || FZR_NEW_CHAT; }
function fzrRosterNow() {
  fzrAgentSeen();
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
  // A pick the agent has not stamped: the agent's words for why, until it does.
  const note = FZR.note[fzrKey()];
  const tip = 'Reviews the work: ' + word + (note ? '. Not applied yet: ' + note : '');
  return '<span class="composer-seat" role="group" aria-label="Reviewer">'
    + '<button class="cchip reviewerchip' + open + (note ? ' is-warn' : '') + '" data-act="fzr:open" data-id="' + esc(choice || '') + '"'
    + ' title="' + esc(tip) + '" aria-label="' + esc(tip) + '">'
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
    body = '<div class="modehead"><span>Add a reviewer</span><span class="cap">added to the Fusion team; only chats that pick it are reviewed</span></div>'
      + (list.length ? list.map((c) => fzrRowHTML({label: c.label, detail: c.detail, disabled: c.disabled}, FZR.adding || c.disabled ? '' : 'fzr:add:' + c.ref)).join('')
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
  if (v === 'open') { S.overlay = 'fzr'; FZR.popFor = fzrKey(); render(); void fzrRefresh(S.agentSession || null); return; }
  if (v === 'addOpen') { S.overlay = 'fzradd'; FZR.popFor = fzrKey(); render(); return; }
  if (v.startsWith('pick:')) {
    const ref = v.slice('pick:'.length);
    const stamped = fzrRosterNow() && fzrRosterNow().chat ? fzrRosterNow().chat.reviewer : null;
    // "Team picks" clears a stamp ("team"); with none stamped there is nothing to send.
    if (ref) FZR.pending[fzrKey()] = ref;
    else if (stamped) FZR.pending[fzrKey()] = FZR_TEAM_PICKS;
    else delete FZR.pending[fzrKey()];
    delete FZR.note[fzrKey()];
    S.overlay = null; render();
    return;
  }
  if (v.startsWith('add:')) {
    const ref = v.slice('add:'.length);
    if (!BR || !BR.fusionTeamWrite) return;
    // Issue #77: the chat it is added from, read now: the person can open another one during the write.
    // A new chat whose first turn already left, not named yet: the reviewer is that turn's chat's.
    // Issue #87: or one sent and not acknowledged yet (no turn id): its dispatch token stands for the turn.
    const firstTurn = fzrKey() === FZR_NEW_CHAT ? (fzrScreenFirstTurn() || fzrScreenDispatch()) : null;
    const startKey = fzrKey();
    const target = firstTurn ? {key: null, turn: firstTurn} : {key: startKey, turn: null};
    FZR.adds.push(target);
    FZR.adding = true; render();
    let res = null;
    try { res = await BR.fusionTeamWrite({op: 'addReviewer', ref}); } catch (e) { res = {ok: false, error: String(e)}; }
    FZR.adding = false;
    FZR.adds = FZR.adds.filter((t) => t !== target);
    // The seat's popover is that chat's while it was opened there (FZR.popFor); another chat's is left alone.
    const ownPop = S.overlay === 'fzr' || S.overlay === 'fzradd' ? FZR.popFor === startKey : false;
    if (!res || !res.ok) {
      const why = (res && res.error) || 'the config write failed';
      if (fzrOnScreen(target)) { toast('Reviewer not added', why); render(); return; }
      // Issue #77: the person moved on; say which chat, and do not leave its popover over another one.
      if (ownPop) S.overlay = null;
      toast('Reviewer not added', 'In ' + fzrChatName(target) + ': ' + why);
      render(); return;
    }
    // The new reviewer is that chat's choice: that is why it was added from there.
    fzrAddPicked(target, ref);
    if (res.live === false) toast('Reviewer added', 'Restart the agent to use it: this agent cannot take config changes live.');
    if (ownPop) S.overlay = null;
    if (typeof refreshLiveConfig === 'function') await refreshLiveConfig();
    await fzrRefresh(S.agentSession || null);
    render();
  }
}

/** The new chat on screen's first turn, sent and not named by its stream yet (renderer.js FIRST_TURNS), or null. */
function fzrScreenFirstTurn() {
  if (typeof screenTurnId !== 'function' || typeof FIRST_TURNS === 'undefined' || !FIRST_TURNS) return null;
  const turnId = screenTurnId();
  return turnId && FIRST_TURNS.has(turnId) ? turnId : null;
}
/** Whether the chat an add is for (fzrAct add:) is the one on screen. */
function fzrOnScreen(target) {
  if (target.turn) return fzrKey() === FZR_NEW_CHAT && fzrScreenFirstTurn() === target.turn;
  return fzrKey() === target.key;
}
/** The chat an add is for, as the toast names it. */
function fzrChatName(target) {
  if (target.turn || !target.key || target.key === FZR_NEW_CHAT) return 'the new chat';
  const row = typeof chatById === 'function' ? chatById(target.key) : null;
  return row && row.t ? '“' + row.t + '”' : 'the chat you added it from';
}
/** A reviewer added from `target` (fzrAct add:) is that chat's pick, or its first turn's while that turn is unnamed. */
function fzrAddPicked(target, ref) {
  if (target.turn) { FZR.byTurn[target.turn] = ref; return; }
  if (!target.key) return;   // a new chat whose first turn ended unnamed
  FZR.pending[target.key] = ref;
  delete FZR.note[target.key];
}
/** Issue #77: an add in flight from the new chat follows it (`to` is the chat's id, or `{turn}`). */
function fzrAddsFollow(from, to) {
  for (const t of FZR.adds) {
    if (from.turn ? t.turn !== from.turn : (t.turn || t.key !== from.key)) continue;
    if (to.turn) { t.key = null; t.turn = to.turn; } else { t.key = to.key; t.turn = null; }
  }
}

/**
 * The team choice a turn of the chat carries (renderer.js BR.chat), or null.
 * Sent with every turn until the agent's answer shows it stamped
 * (fzrReconcile): a turn the agent refused leaves it pending.
 */
function fzrTurnTeam(session) {
  const key = session || FZR_NEW_CHAT;
  const reviewer = FZR.pending[key];
  return reviewer ? {reviewer} : null;
}
/**
 * The send went out as turn `turnId`, with the pick `sent` (or null). A new chat's pick leaves the new-chat
 * slot with it: it is that turn's, and becomes the chat's only when the
 * turn's stream names the chat (fzrTurnNamed). Issue #74: it used to move to
 * whichever chat was refreshed next, an unrelated one opened meanwhile.
 */
function fzrTurnSent(session, turnId, sent, token) {
  if (session || !turnId) return;
  // Issue #87: tied to the turn at dispatch (fzrTurnDispatch): the token's pick and adds are the turn id's now.
  if (token) { fzrRekeyTurn(token, turnId); return; }
  // Issue #77: a reviewer being added from the new chat is this turn's too, picked or not (`sent` null).
  fzrAddsFollow({key: FZR_NEW_CHAT}, {turn: turnId});
  if (!sent) return;
  if (FZR.pending[FZR_NEW_CHAT] === sent.reviewer) delete FZR.pending[FZR_NEW_CHAT];
  FZR.byTurn[turnId] = sent.reviewer;
}
/**
 * Issue #87: renderer.js is sending a new chat's turn (`session` empty), right
 * before BR.chat, synchronously. The turn id comes only with BR.chat's answer,
 * so a dispatch token stands for it until then: the pick the turn carries and
 * any add in flight from the new chat are the token's from here, never the
 * new-chat slot's, whichever of the add and the answer ends first. An add
 * started before the answer joins it too (fzrAct add:). Returns the token, or
 * null for a stored chat.
 */
function fzrTurnDispatch(session) {
  if (session) return null;
  const token = '\u0000dispatch:' + (++FZR.dispatch);
  fzrAddsFollow({key: FZR_NEW_CHAT}, {turn: token});
  if (FZR.pending[FZR_NEW_CHAT] !== undefined) {
    FZR.byTurn[token] = FZR.pending[FZR_NEW_CHAT];
    delete FZR.pending[FZR_NEW_CHAT];
  }
  FZR.newDispatch = token;
  // The screen that sent it (fzrScreenChanged counts each chat put on screen; Clear Transcript is not one).
  FZR.newDispatchScreen = FZR.screen;
  return token;
}
/**
 * Issue #87 review: the new chat on screen's first turn, sent and not
 * acknowledged yet: its dispatch token while the screen still shows the chat
 * that sent it, else null (the person opened a fresh New chat meanwhile: an
 * add there is that chat's slot's, never the sent one's).
 */
function fzrScreenDispatch() {
  if (!FZR.newDispatch) return null;
  return FZR.newDispatchScreen === FZR.screen ? FZR.newDispatch : null;
}
/**
 * Issue #87 review: another chat is on screen (renderer.js session:new and
 * openSession; a new agent, fzrAgentChanged). Clear Transcript keeps the chat,
 * so it does not count. A first turn still waiting for its send's answer stays
 * that turn's; adds from here on are the new screen's.
 */
function fzrScreenChanged() {
  FZR.screen++;
  // The waiting turn is not this screen's: nothing started here joins it (its token still re-keys on the answer).
  FZR.newDispatch = null; FZR.newDispatchScreen = null;
}
/** Issue #87: the send's answer named the turn: what the dispatch token held is the turn id's. */
function fzrRekeyTurn(token, turnId) {
  fzrAddsFollow({turn: token}, {turn: turnId});
  if (Object.prototype.hasOwnProperty.call(FZR.byTurn, token)) { FZR.byTurn[turnId] = FZR.byTurn[token]; delete FZR.byTurn[token]; }
  if (FZR.newDispatch === token) { FZR.newDispatch = null; FZR.newDispatchScreen = null; }
}
/** Issue #87: the send failed (no turn): its pick and adds go back to the new-chat slot, for the retry. */
function fzrTurnUndispatched(token) {
  if (!token) return;
  fzrAddsFollow({turn: token}, {key: FZR_NEW_CHAT});
  if (Object.prototype.hasOwnProperty.call(FZR.byTurn, token)) {
    if (FZR.pending[FZR_NEW_CHAT] === undefined) FZR.pending[FZR_NEW_CHAT] = FZR.byTurn[token];
    delete FZR.byTurn[token];
  }
  if (FZR.newDispatch === token) { FZR.newDispatch = null; FZR.newDispatchScreen = null; }
}
/** A new chat got its id before its first turn (renderer.js submit, a `waiting-…` chat): its pick is that chat's. */
function fzrAdoptNewChat(sid) {
  if (sid) fzrAddsFollow({key: FZR_NEW_CHAT}, {key: sid});
  if (!sid || FZR.pending[FZR_NEW_CHAT] === undefined) return;
  if (FZR.pending[sid] === undefined) FZR.pending[sid] = FZR.pending[FZR_NEW_CHAT];
  delete FZR.pending[FZR_NEW_CHAT];
  delete FZR.note[FZR_NEW_CHAT];
}
/** Turn `turnId`'s stream named its chat `sid` (renderer.js firstTurnNamed), or ended unnamed (sid null). */
function fzrTurnNamed(turnId, sid) {
  if (turnId) fzrAddsFollow({turn: turnId}, {key: sid || null});
  if (!turnId || !Object.prototype.hasOwnProperty.call(FZR.byTurn, turnId)) return;
  const pick = FZR.byTurn[turnId];
  delete FZR.byTurn[turnId];
  if (sid && FZR.pending[sid] === undefined) FZR.pending[sid] = pick;
}

/** The agent's answer for chat `sid` shows its pick stamped: it is used up. */
function fzrReconcile(sid) {
  const pending = FZR.pending[sid];
  if (pending === undefined || !FZR.roster || !FZR.roster.known) return;
  const stamped = FZR.roster.chat ? FZR.roster.chat.reviewer : null;
  if (pending === stamped || (pending === FZR_TEAM_PICKS && stamped === null)) {
    delete FZR.pending[sid];
    delete FZR.note[sid];
  }
}

/** A turn of chat `sid` ended (renderer.js): the stamp is read back; a refusal's words stay on the seat. */
async function fzrTurnEnded(sid, error) {
  if (!sid) return;
  if (FZR.pending[sid] !== undefined && error) FZR.note[sid] = String(error).slice(0, 300);
  if (typeof S === 'undefined' || sid === S.agentSession) await fzrRefresh(sid);
}

/** Ask the agent for the team as chat `sid` can use it (on open, at a turn's end, after a write). */
async function fzrRefresh(sid) {
  if (typeof BR === 'undefined' || !BR || !BR.fusionTeam) return;
  fzrAgentSeen();
  const token = ++FZR.token;
  if (FZR.sid !== sid) FZR.roster = null;
  FZR.sid = sid; FZR.asked = sid;
  let roster = null;
  try { roster = await BR.fusionTeam(sid); } catch (e) { roster = null; }
  if (token !== FZR.token) return;
  FZR.roster = roster && roster.known ? roster : {known: false, configured: false, directors: [], workers: [], reviewers: [], review: null, chat: null};
  if (sid) fzrReconcile(sid);
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
  module.exports = {fzrScreenChanged, fzrTurnDispatch, fzrTurnUndispatched, fzrRows, fzrSeatWord, fzrCandidates, fzrChoice, fzrMemberLabel, fzrEntryRef, fzrTurnTeam, fzrTurnSent, fzrTurnNamed, fzrAdoptNewChat, fzrReconcile, FZR, FZR_ADD_HINT};
}
