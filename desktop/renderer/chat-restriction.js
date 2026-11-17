/* ---------------- Issue #67: "restricted to: …" in the composer ----------------
   Loaded before renderer.js; declares only, and reads renderer.js globals
   (S, LIVE_CONFIG, esc, ic, providerWord, rmNow, BR) at call time.

   A chat whose folder has a `projects.constraints` entry, or that read files
   inside one, may use only the providers the entry allows: the TUI composer
   says "restricted to: <providers>" after the route. Here the same chip sits
   after the route chips (renderer.js composer()), from the agent's
   GET /api/sessions/{id}/provider-restriction, read by main
   (main/provider-restriction.ts, IPC agent:providerRestriction). The
   tooltip says why, which providers and which egress classes are allowed,
   and what Fusion does then (src/runtime/fusion-policy-degradation.ts: only
   the allowed side runs).

   Asked when a chat is opened and when each of its turns ends (a read inside
   a restricted folder narrows the chat mid-turn). An older agent, an error,
   an unrestricted chat, or a new chat before its first turn: no chip. */

const RESTRICT = {sid: null, info: null, token: 0};

/** The chip's words: the agent's label ("restricted to: local-llama"). */
function restrictionChipLabel(info) {
  const r = info && info.restriction;
  if (!r) return '';
  return r.label || ('restricted to: ' + (r.allowedProviders.length ? r.allowedProviders.join(', ') : 'no provider'));
}

/* The egress classes the chat may use, from config.json's entries, or null
   when they cannot all be read there. The agent's key is the folder's entry,
   "A + B" for several, and a read taint adds the entries in `readFrom`; the
   chat's policy is their intersection (provider-policy.ts). */
function restrictionEgress(r, config) {
  const all = config && config.projects && config.projects.constraints;
  if (!all || typeof all !== 'object') return null;
  const keys = [...new Set(String(r.folder || '').split(' + ').concat(r.readFrom || []).filter(Boolean))];
  if (!keys.length) return null;
  let out = null;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(all, k)) return null;
    const e = all[k] || {};
    const list = Array.isArray(e.allowedEgress) ? e.allowedEgress.filter((x) => typeof x === 'string') : [];
    out = out === null ? list : out.filter((x) => list.includes(x));
  }
  return out;
}

/* What Fusion does under the restriction (fusionPolicyDegradation). */
function restrictionFusionLine(rm, allowed, word) {
  if (!rm || rm.effective !== 'fusion') return 'In Fusion, only the side these providers allow would run.';
  const orch = rm.orchestratorProviderId || rm.primaryProviderId || null;
  const worker = rm.workerProviderId || null;
  const orchOk = !!orch && allowed.includes(orch);
  const workerOk = !!worker && allowed.includes(worker);
  if (orchOk && workerOk) return 'Fusion: both sides are allowed.';
  if (orchOk) return 'Fusion: the orchestrator (' + word(orch) + ') works alone, without workers.';
  if (workerOk) return "Fusion: only the workers' model (" + word(worker) + ') runs, on its own.';
  return 'Fusion: neither side is allowed, so the turn runs on an allowed provider if there is one.';
}

/** The chip's tooltip, one line per fact. `opts`: {config, rm, word}. */
function restrictionTip(info, opts) {
  const r = info && info.restriction;
  if (!r) return '';
  const word = (opts && opts.word) || ((id) => id);
  const lines = [];
  if (info.provisional) {
    lines.push("This new chat's folder (" + info.dir + ") is restricted in projects.constraints. From this window's config: the agent confirms it once the first message is sent.");
  } else lines.push(r.readFrom && r.readFrom.length
    ? 'This chat read files from ' + r.readFrom.join(', ') + ', which ' + (r.readFrom.length > 1 ? 'are' : 'is') + ' restricted in projects.constraints.'
    : "This chat's folder (" + r.folder + ') is restricted in projects.constraints.');
  lines.push('Providers allowed: ' + (r.allowedProviders.length ? r.allowedProviders.map(word).join(', ') : 'none') + '.');
  /* Review of #67: the agent's `channelsAllowed` is the authority and is
     always said. The config's list is this window's file: not the remote
     agent's, and not a read-taint stamp's from before an edit, so it is
     shown only for an agent on this computer and only when it agrees. */
  const said = info.channelsAllowed === true || info.channelsAllowed === false;
  let egress = info.remote === true ? null : restrictionEgress(r, opts && opts.config);
  if (egress !== null && said && egress.includes('channels') !== info.channelsAllowed) egress = null;
  if (egress !== null) lines.push('Allowed to leave this computer: ' + (egress.length ? egress.join(', ') : 'nothing') + '.');
  if (said) lines.push('Chat channels and phone push: ' + (info.channelsAllowed ? 'allowed' : 'not allowed') + '.');
  lines.push(restrictionFusionLine(opts && opts.rm, r.allowedProviders, word));
  return lines.join('\n');
}

/* Review of #67: a path as projects.constraints keys compare (core
   normalizeConstraintPath, without resolving links): one separator, no
   trailing one, lower case on Windows and macOS. */
function restrictionPathKey(dir) {
  let s = String(dir == null ? '' : dir).trim().replace(/[\\/]+/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  const fold = (typeof IS_WIN !== 'undefined' && IS_WIN) || (typeof IS_MAC !== 'undefined' && IS_MAC);
  return fold ? s.toLowerCase() : s;
}

/* A chat with no session yet (before its first message, or while that turn
   has not been named): the restriction its folder will carry, worked out from
   this window's projects.constraints (the deepest entry holding the folder,
   as the agent picks it), or null. Only for an agent on this computer, whose
   config this is; marked `provisional`: the agent's answer replaces it. */
function restrictionProvisional(dir, config) {
  const pm = typeof ProjectModels !== 'undefined' && ProjectModels && ProjectModels.state;
  if (!dir || !pm || !pm.loaded || pm.remote) return null;
  const all = config && config.projects && config.projects.constraints;
  if (!all || typeof all !== 'object') return null;
  const d = restrictionPathKey(dir);
  let best = null;
  for (const [key, entry] of Object.entries(all)) {
    const k = restrictionPathKey(key);
    if (!k || !entry || !Array.isArray(entry.allowedProviders)) continue;
    const inside = d === k || d.startsWith(k.endsWith('/') ? k : k + '/');
    if (inside && (!best || k.length > best.len)) best = {key, entry, len: k.length};
  }
  if (!best) return null;
  const allowed = best.entry.allowedProviders.filter((x) => typeof x === 'string');
  return {known: true, provisional: true, dir: String(dir), channelsAllowed: null, remote: false,
    restriction: {label: 'restricted to: ' + (allowed.length ? allowed.join(', ') : 'no provider'), allowedProviders: allowed, folder: best.key, readFrom: []}};
}

/** The folder a chat with no session yet opens in: its project's, else the window's. */
function restrictionNewChatDir() {
  // Review of #67: its first turn's own folder once sent (the mark is used up at the send).
  const running = typeof chatWorkingDir === 'function' ? chatWorkingDir() : '';
  if (running) return running;
  const mark = typeof projectMarkedInfo === 'function' ? projectMarkedInfo() : null;
  return (mark && mark.folder) || (typeof workingDir === 'function' ? workingDir() : '');
}

/** The chip for the chat on screen, or '' (renderer.js composer(), after the route chips). */
function restrictionChipHTML() {
  const info = !S.agentSession
    ? restrictionProvisional(restrictionNewChatDir(), typeof LIVE_CONFIG !== 'undefined' ? LIVE_CONFIG : null)
    : RESTRICT.sid && RESTRICT.sid === S.sessionId ? RESTRICT.info : null;
  if (!info || !info.restriction) return '';
  const label = restrictionChipLabel(info);
  const tip = restrictionTip(info, {
    config: typeof LIVE_CONFIG !== 'undefined' ? LIVE_CONFIG : null,
    rm: typeof rmNow === 'function' ? rmNow() : null,
    word: typeof providerWord === 'function' ? providerWord : (id) => id,
  });
  return '<span class="cchip restrictchip' + (info.provisional ? ' provisional' : '') + '" tabindex="0" title="' + esc(tip) + '" aria-label="' + esc(label + '. ' + tip.replace(/\n/g, ' ')) + '">'
    + ic('lock') + '<span class="cval">' + esc(label) + '</span></span>';
}

/* The chip in place, without a render() (the person may be typing). */
function restrictionRepaint() {
  const foot = document.querySelector('#composer .cfoot');
  if (!foot) return;
  const html = restrictionChipHTML();
  const el = foot.querySelector('.restrictchip');
  if (el) {
    if (!html) el.remove();
    else if (typeof chipSwap === 'function') chipSwap(el, html);
    return;
  }
  if (!html) return;
  const spacer = foot.querySelector(':scope > .cgrow');
  if (spacer) spacer.insertAdjacentHTML('beforebegin', html);
}

/** Ask the agent about chat `sid` (on open, and when its turn ends). */
async function restrictionRefresh(sid, retried) {
  if (!sid || typeof BR === 'undefined' || !BR || !BR.providerRestriction) return;
  const token = ++RESTRICT.token;
  let info = null;
  try { info = await BR.providerRestriction(sid); } catch (e) { info = null; }
  // A newer ask, or the person has moved to another chat: this answer is not drawn.
  if (token !== RESTRICT.token || sid !== S.sessionId) return;
  RESTRICT.sid = sid;
  RESTRICT.info = info && info.known ? info : null;
  restrictionRepaint();
  /* Review of #67: a 404 at a first turn's end is a chat the agent has not
     stored yet (it writes the turn as its loop winds down): asked once more,
     after the sidebar stand-in's own grace, unless the window moved on. */
  if (!retried && info && !info.known && info.status === 404) {
    const ms = typeof PENDING_GRACE_MS === 'number' ? PENDING_GRACE_MS : 5000;
    setTimeout(() => { if (token === RESTRICT.token && sid === S.sessionId) void restrictionRefresh(sid, true); }, ms);
  }
}

/** A turn of chat `sid` ended: asked again when that chat is on screen (a read may have restricted it). */
async function restrictionTurnEnded(sid) {
  if (sid && sid === S.sessionId) await restrictionRefresh(sid);
}

/* Review of #67: a config read (renderer.js refreshLiveConfig, after every
   write) whose projects.constraints changed asks again for the chat on screen;
   a new chat's provisional chip follows the next render by itself. */
async function restrictionConfigChanged(before, after) {
  const of = (c) => JSON.stringify((c && c.projects && c.projects.constraints) || null);
  if (of(before) === of(after)) return;
  if (S.agentSession) await restrictionRefresh(S.agentSession);
  else restrictionRepaint();
}

if (typeof module !== 'undefined') {
  module.exports = {restrictionChipLabel, restrictionTip, restrictionEgress, restrictionFusionLine, restrictionPathKey};
}
