// Safe-behavior assertions for a disposable C2b candidate. No remote requests.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.env.C2_CANDIDATE_ROOT ?? process.cwd());
const configDir = mkdtempSync(join(tmpdir(), 'c2b-audit-config-'));
process.env.ATOMIC_AGENT_STATE_DIR = configDir;
after(() => rmSync(configDir, { recursive: true, force: true }));
const load = name => import(pathToFileURL(join(root, name)).href);
const { createNextStepSuggester } = await load('src/runtime/composition/runtime-next-step.ts');
const { readNextStepEndpoint, generateNextStepViaEndpoint } = await load('src/session/next-step-endpoint.ts');
const { createEmptySessionState } = await load('src/session/session-state.ts');
const { runWithProviderPolicy, makeProviderPolicy } = await load('src/llm/provider-policy.ts');
const { setOfflineNetwork } = await load('src/llm/offline-network.ts');
const { setPrivacyShieldEnabled, setPrivacyKnownSecrets, withFreshPrivacyVault, resetPrivacyVaults } = await load('src/privacy/index.ts');
const { StructuredLogger } = await load('src/tracing/structured-logger.ts');
const { extendCloudContext } = await load('src/session/cloud-context.ts');
const SECRET = 'c2b-synthetic-secret-0123456789';
const state = () => ({ ...createEmptySessionState({ id: 'c2b-audit', workingDir: root }), turnCount: 1,
  turns: [{ kind: 'user', text: `Use ${SECRET} for the audit`, at: 1 }, { kind: 'assistant_reply', text: 'The audit is ready.', at: 2 }] });
const endpoint = (url = 'https://suggestions.invalid/v1/chat/completions') => ({ url, model: 'small-audit-model', apiKey: SECRET });
const response = (text = 'Add audit tests', status = 200) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status });
function rig(options = {}) {
  const current = state(); const rows = new Map([[current.id, current]]); const calls = []; const logs = []; const events = [];
  const deps = { getConfig: () => ({ agent: {}, tui: { nextStepSuggestions: true }, localModels: { useServerTemplate: 'off' } }),
    sessionStore: { load: id => rows.get(id) ?? null, save: value => rows.set(value.id, value) },
    llmComplete: async () => { throw new Error('unexpected main-model call'); }, slotManager: { sideCallSlotId: () => 0 },
    resolveTransport: () => 'native_tools', pending: new Set(), isShutdown: () => false,
    emitEvent: (...args) => events.push(args), nextStepEndpoint: () => endpoint(),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response(); },
    logger: new StructuredLogger({ level: 'debug', sinks: [record => logs.push(record)] }), ...options };
  return { current, rows, calls, logs, events, deps, suggester: createNextStepSuggester(deps) };
}

test('C2b: offline suppresses the separate endpoint even on loopback', async () => {
  const r = rig({ nextStepEndpoint: () => endpoint('http://127.0.0.1:8081/v1/chat/completions') });
  setOfflineNetwork(true);
  try { await r.suggester.maybeSuggest(r.current, 'http'); assert.equal(r.calls.length, 0); }
  finally { setOfflineNetwork(false); }
});
test('C2b: a local-only provider policy refuses a nonlocal suggestion endpoint', async () => {
  const r = rig(); const policy = makeProviderPolicy({ key: 'local-only', allowedProviders: ['local-llama'], allowedEgress: [], matchedDir: root });
  await runWithProviderPolicy(policy, () => r.suggester.maybeSuggest(r.current, 'http'), { sessionId: r.current.id });
  assert.equal(r.calls.length, 0, 'raw fetch bypassed the configured provider policy');
});
test('C2b: the endpoint honors the allowed provider hosts', async () => {
  const r = rig(); const policy = makeProviderPolicy({ key: 'host-limited', allowedProviders: ['approved-cloud'],
    allowedProviderHosts: ['approved.invalid'], allowedEgress: [], matchedDir: root });
  await runWithProviderPolicy(policy, () => r.suggester.maybeSuggest(r.current, 'http'), { sessionId: r.current.id });
  assert.equal(r.calls.length, 0, 'raw fetch bypassed the configured host allow-list');
});
test('C2b: Privacy Shield masks the transmitted text on both HTTP-400 attempts', async () => {
  const calls = []; const r = rig({ fetchImpl: async (url, init) => { calls.push({ url, init }); return response('Add tests', calls.length === 1 ? 400 : 200); } });
  setPrivacyShieldEnabled(true); setPrivacyKnownSecrets(() => [{ value: SECRET, source: 'c2b-audit' }]);
  try {
    await withFreshPrivacyVault(() => r.suggester.maybeSuggest(r.current, 'http'));
    assert.equal(calls.length, 2);
    assert.equal(JSON.stringify(calls.map(x => JSON.parse(x.init.body).messages)).includes(SECRET), false,
      'the first request and retry transmitted a known credential in conversation text');
  } finally { setPrivacyShieldEnabled(false); setPrivacyKnownSecrets(() => []); resetPrivacyVaults(); }
});
test('C2b: malformed environment keys are rejected by the validated credential path', () => {
  const parsed = readNextStepEndpoint({ ATOMIC_AGENT_NEXT_STEP_URL: 'http://127.0.0.1:8081', ATOMIC_AGENT_NEXT_STEP_API_KEY: 'placeholder with spaces' });
  assert.ok(parsed === null || parsed.apiKey === null, 'raw environment value became a bearer key');
});
test('C2b: URL userinfo cannot become an endpoint credential', () => {
  assert.equal(readNextStepEndpoint({ ATOMIC_AGENT_NEXT_STEP_URL: 'https://audit:password@example.invalid/v1' }), null);
});
test('C2b: a reflected credential never reaches logs after the no-thinking retry', async () => {
  let attempts = 0;
  const r = rig({ fetchImpl: async () => { if (++attempts === 1) return response('', 400); throw new Error(`synthetic transport error ${SECRET}`); } });
  await r.suggester.maybeSuggest(r.current, 'http'); assert.equal(attempts, 2);
  assert.equal(JSON.stringify(r.logs).includes(SECRET), false, 'unfiltered endpoint error reached a logger sink');
});
test('C2b control: the HTTP-400 retry drops thinking and preserves the intended key', async () => {
  const calls = []; const result = await generateNextStepViaEndpoint(state(), endpoint(), { fetchImpl: async (url, init) => {
    calls.push({ url, init }); return response('Add tests', calls.length === 1 ? 400 : 200);
  } });
  assert.equal(result, 'Add tests'); assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].init.body).chat_template_kwargs.enable_thinking, false);
  assert.equal(JSON.parse(calls[1].init.body).chat_template_kwargs, undefined);
  assert.equal(calls[1].init.headers.authorization, `Bearer ${SECRET}`);
});
test('C2b control: remote incognito requests are skipped by runtime', async () => {
  const r = rig(); await r.suggester.maybeSuggest({ ...r.current, incognito: { since: 1, owner: 'audit' } }, 'http');
  assert.equal(r.calls.length, 0); assert.equal(r.events.length, 0);
});
test('C2b control: model output stays bounded data and never becomes a transcript tool', async () => {
  const r = rig({ fetchImpl: async () => response('x'.repeat(2000)) });
  const before = structuredClone(r.current.turns); await r.suggester.maybeSuggest(r.current, 'http');
  const after = r.rows.get(r.current.id); assert.ok(after.metadata.nextStep.text.length <= 120);
  assert.deepEqual(after.turns, before); assert.equal(after.metadata.nextStep.afterTurn, 1);
  const journal = extendCloudContext(undefined, after.turns, new Map());
  assert.equal(JSON.stringify(journal).includes('x'.repeat(120)), false);
  assert.deepEqual(r.events.map(x => x[1].type), ['next_step_suggestion']);
});
test('C2b control: endpoint errors settle the auxiliary call without throwing', async () => {
  const r = rig({ fetchImpl: async () => { throw new Error('synthetic unavailable'); } });
  await r.suggester.maybeSuggest(r.current, 'http'); assert.equal(r.deps.pending.size, 0); assert.equal(r.events.length, 0);
});
test('C2b control: runtime deadline aborts an endpoint that honors its signal', { timeout: 20_000 }, async () => {
  const r = rig({ fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    assert.ok(init.signal); init.signal.addEventListener('abort', () => reject(new Error('audit timeout')), { once: true });
  }) });
  const keepAlive = setInterval(() => {}, 1000); const started = Date.now();
  try {
    await r.suggester.maybeSuggest(r.current, 'http'); assert.ok(Date.now() - started < 19_000);
    assert.equal(r.deps.pending.size, 0); assert.equal(r.events.length, 0);
  } finally { clearInterval(keepAlive); }
});
