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
  lines.push(r.readFrom && r.readFrom.length
    ? 'This chat read files from ' + r.readFrom.join(', ') + ', which ' + (r.readFrom.length > 1 ? 'are' : 'is') + ' restricted in projects.constraints.'
    : "This chat's folder (" + r.folder + ') is restricted in projects.constraints.');
  lines.push('Providers allowed: ' + (r.allowedProviders.length ? r.allowedProviders.map(word).join(', ') : 'none') + '.');
  const egress = restrictionEgress(r, opts && opts.config);
  if (egress !== null) lines.push('Allowed to leave this computer: ' + (egress.length ? egress.join(', ') : 'nothing') + '.');
  else if (info.channelsAllowed === true || info.channelsAllowed === false) {
    lines.push('Chat channels and phone push: ' + (info.channelsAllowed ? 'allowed' : 'not allowed') + '.');
  }
  lines.push(restrictionFusionLine(opts && opts.rm, r.allowedProviders, word));
  return lines.join('\n');
}

/** The chip for the chat on screen, or '' (renderer.js composer(), after the route chips). */
function restrictionChipHTML() {
  const info = RESTRICT.info;
  if (!info || !info.restriction || !RESTRICT.sid || RESTRICT.sid !== S.sessionId) return '';
  const label = restrictionChipLabel(info);
  const tip = restrictionTip(info, {
    config: typeof LIVE_CONFIG !== 'undefined' ? LIVE_CONFIG : null,
    rm: typeof rmNow === 'function' ? rmNow() : null,
    word: typeof providerWord === 'function' ? providerWord : (id) => id,
  });
  return '<span class="cchip restrictchip" tabindex="0" title="' + esc(tip) + '" aria-label="' + esc(label + '. ' + tip.replace(/\n/g, ' ')) + '">'
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
async function restrictionRefresh(sid) {
  if (!sid || typeof BR === 'undefined' || !BR || !BR.providerRestriction) return;
  const token = ++RESTRICT.token;
  let info = null;
  try { info = await BR.providerRestriction(sid); } catch (e) { info = null; }
  // A newer ask, or the person has moved to another chat: this answer is not drawn.
  if (token !== RESTRICT.token || sid !== S.sessionId) return;
  RESTRICT.sid = sid;
  RESTRICT.info = info && info.known ? info : null;
  restrictionRepaint();
}

if (typeof module !== 'undefined') {
  module.exports = {restrictionChipLabel, restrictionTip, restrictionEgress, restrictionFusionLine};
}
