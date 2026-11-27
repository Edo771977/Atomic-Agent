import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = resolve(process.env.C3_CANDIDATE_ROOT ?? process.cwd());
const load = p => import(pathToFileURL(join(root, 'src', p)).href);
const JSZip = (await import(pathToFileURL(join(root, 'node_modules/jszip/lib/index.js')).href)).default;
const { readChatExport } = await load('import/user-facts/read-chat-export.ts');
const { chatGptExportFixture } = await load('import/user-facts/chatgpt-export.fixture.ts');
const { ImportFactsJobs } = await load('import/user-facts/import-facts-jobs.ts');
const { startImportFacts, saveImportFacts, undoImportFacts } = await load('import/user-facts/import-facts-service.ts');
const { bindImportFactsModel, isLocalProviderEntry } = await load('import/user-facts/import-facts-model.ts');
const { ProfileStore } = await load('memory/profile-store.ts');
const { MemoryStore } = await load('memory/memory-store.ts');
const { getConfig, resetConfigCache, USER_CONFIG_VERSION } = await load('config/index.ts');
const { guardProvider, makeProviderPolicy, runWithProviderPolicy } = await load('llm/provider-policy.ts');
const { ROUTE_SCOPES } = await load('http/http-scopes.ts');
const { createHttpServer } = await load('http/http-server.ts');
const { hashHttpToken } = await load('http/http-token-store.ts');
const handlers = await load('http/route-import-facts.ts');
const { shieldVaultFor } = await load('llm/provider/openai/openai-privacy-shield.ts');
const { setPrivacyShieldEnabled, resetPrivacyVaults } = await load('privacy/privacy-vault-registry.ts');
const { offlineRefusal: offlineRefusalFor, setOfflineNetwork: setOfflineMode } = await load('llm/offline-network.ts');
const { getStateSecretPaths } = await load('config/config-file.ts');
const { findStateSecretReads } = await load('tools/read-scope/state-secrets.ts');
const base = mkdtempSync(join(tmpdir(), 'c3b-audit-'));
after(() => rmSync(base, { recursive: true, force: true }));
let serial = 0;
function folder() { const d = join(base, String(serial++)); mkdirSync(d); return d; }
const sample = () => JSON.stringify(chatGptExportFixture(['I am a designer from Berlin']));
async function zipFile(entries) {
  const z = new JSZip();
  for (const [name, body, options] of entries) z.file(name, body, options);
  const path = join(folder(), 'export.zip');
  writeFileSync(path, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' }));
  return path;
}
for (const source of ['chatgpt', 'claude']) {
  for (const [kind, name, options] of [
    ['parent traversal', '../conversations.json', {}],
    ['absolute entry', '/conversations.json', {}],
    ['symlink entry', 'conversations.json', { unixPermissions: 0o120777 }],
  ]) test(`${source}: reject archive ${kind}`, async () => {
    const path = await zipFile([[name, '[]', options]]);
    await assert.rejects(readChatExport(source, path));
  });
  test(`${source}: reject an entry above the fork 10 MiB decompressed cap`, async () => {
    const path = await zipFile([['conversations.json', '[]' + ' '.repeat(10 * 1024 * 1024)]]);
    await assert.rejects(readChatExport(source, path));
  });
  test(`${source}: reject more than the fork 10000 archive entries`, async () => {
    const entries = [['conversations.json', '[]']];
    for (let i = 0; i < 10000; i++) entries.push([`entry-${i}`, '']);
    await assert.rejects(readChatExport(source, await zipFile(entries)));
  });
  test(`${source}: reject deeply nested JSON before projection`, async () => {
    const d = folder();
    writeFileSync(join(d, 'conversations.json'), '[{"unused":' + '['.repeat(3000) + '0' + ']'.repeat(3000) + '}]');
    await assert.rejects(readChatExport(source, d));
  });
  test(`${source}: a folder does not follow conversations.json outside its root`, async t => {
    const outside = folder(); const d = folder();
    writeFileSync(join(outside, 'conversations.json'), '[]');
    try { symlinkSync(join(outside, 'conversations.json'), join(d, 'conversations.json'), 'file'); }
    catch (err) { if (err.code === 'EPERM') { t.skip('Windows does not grant file symlink creation'); return; } throw err; }
    await assert.rejects(readChatExport(source, d));
  });
}
test('archive total decompressed size is capped at the fork 100 MiB', async () => {
  const entries = [['conversations.json', '[]']];
  const block = ' '.repeat(10 * 1024 * 1024);
  for (let i = 0; i < 11; i++) entries.push([`unused-${i}`, block]);
  await assert.rejects(readChatExport('chatgpt', await zipFile(entries)));
});
test('JSON byte bound also applies to unpacked folders', async () => {
  const d = folder(); writeFileSync(join(d, 'conversations.json'), '[]' + ' '.repeat(10 * 1024 * 1024));
  await assert.rejects(readChatExport('chatgpt', d));
});
test('reader honors the fork protected-input inventory', async () => {
  const stateDir = folder(); const file = join(stateDir, 'serve-api.key');
  const files = getStateSecretPaths({ stateDir, userConfigFile: join(stateDir, 'config.json'), localModelsDataDir: stateDir });
  writeFileSync(file, readFileSync(await zipFile([['conversations.json', '[]']])));
  assert.ok(findStateSecretReads('os.fs.read', { path: file }, { workingDir: stateDir }, { stateDir, files }).length > 0, 'fork protection control');
  await assert.rejects(readChatExport('chatgpt', file));
});
const routeSpecs = [
  ['POST', '/api/import/facts/start', 'admin', 'createStartImportFactsHandler'],
  ['GET', '/api/import/facts/jobs/{id}', 'read', 'createGetImportFactsJobHandler'],
  ['POST', '/api/import/facts/jobs/{id}/stop', 'admin', 'createStopImportFactsJobHandler'],
  ['POST', '/api/import/facts/jobs/{id}/save', 'admin', 'createSaveImportFactsHandler'],
  ['DELETE', '/api/import/facts/jobs/{id}', 'admin', 'createForgetImportFactsJobHandler'],
  ['GET', '/api/import/facts/receipts', 'read', 'createListImportReceiptsHandler'],
  ['POST', '/api/import/facts/receipts/{id}/undo', 'admin', 'createUndoImportReceiptHandler'],
];
test('all seven facts routes have the scopes specified by dc5a4b980', () => {
  for (const [method, path, scope] of routeSpecs) assert.equal(ROUTE_SCOPES[`${method} ${path}`], scope, `${method} ${path}`);
});
async function fixture(fn, disabled = false) {
  const d = folder(); const state = folder(); const before = process.env.ATOMIC_AGENT_STATE_DIR;
  process.env.ATOMIC_AGENT_STATE_DIR = state;
  writeFileSync(join(state, 'config.json'), JSON.stringify({ version: USER_CONFIG_VERSION, memory: { profile: { enabled: !disabled }, notes: { enabled: !disabled } } }));
  resetConfigCache(); const config = getConfig();
  assert.equal(config.memory.notes.enabled, !disabled);
  assert.equal(config.memory.profile.enabled, !disabled);
  writeFileSync(join(d, 'conversations.json'), sample());
  const dbFile = join(state, 'memory.sqlite');
  const profileStore = new ProfileStore({ dbFile }); const memoryStore = new MemoryStore({ dbFile, maxEntries: 100 });
  const deps = { jobs: new ImportFactsJobs(), llm: { providers: [{ id: 'local-llama', kind: 'llama-server' }], activeTextProvider: 'local-llama', getProvider: () => ({ complete: async () => ({ content: 'SET job=designer', toolCalls: [] }) }) }, profileStore, memoryStore, stateDir: state };
  try { await fn({ d, state, config, deps }); }
  finally { deps.jobs.forget(deps.jobs.get('')?.id ?? ''); profileStore.close(); memoryStore.close(); resetConfigCache(); if (before === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR; else process.env.ATOMIC_AGENT_STATE_DIR = before; }
}
async function done(deps, d) {
  const job = startImportFacts(deps, { source: 'chatgpt', path: d, engine: { kind: 'local' } });
  await deps.jobs.settled();
  assert.equal(deps.jobs.get(job.id)?.state, 'done');
  return { job, ids: deps.jobs.candidatesOf(job.id).map(c => c.id) };
}
test('memory disabled refuses service saves with the actual disabled fork config', () => fixture(async ({ deps, d }) => {
  const { job, ids } = await done(deps, d); saveImportFacts(deps, job.id, ids);
  assert.equal(deps.profileStore.list().length, 0);
}, true));
test('scope follows the job into a later person save request', () => fixture(async ({ deps, d }) => {
  const policy = makeProviderPolicy({ key: 'private-c3', allowedProviders: ['local-llama'], allowedEgress: [], matchedDir: d });
  const { job, ids } = await runWithProviderPolicy(policy, () => done(deps, d));
  saveImportFacts(deps, job.id, ids);
  assert.equal(deps.profileStore.get('job'), null, 'scoped import became globally visible');
}));
test('control: unapproved candidates stay out of state files and undo preserves unrelated data', () => fixture(async ({ deps, d, state }) => {
  const { job, ids } = await done(deps, d);
  assert.equal(deps.profileStore.list().length, 0);
  for (const name of readdirSync(state)) assert.equal(readFileSync(join(state, name)).includes(Buffer.from('designer')), false, name);
  deps.profileStore.set('language', 'Italian');
  const saved = saveImportFacts(deps, job.id, ids);
  undoImportFacts(deps, saved.receiptId);
  assert.equal(deps.profileStore.get('job'), null); assert.equal(deps.profileStore.get('language')?.value, 'Italian');
}));
test('stop settles an in-flight completion even if its transport ignores abort', async () => {
  const jobs = new ImportFactsJobs(); let release;
  const pending = new Promise(r => { release = r; });
  const job = jobs.start({ source: 'chatgpt', engine: { kind: 'local' }, providerId: 'local', local: true, readChats: async () => [{ id: 'c', messages: [{ role: 'user', text: 'I am a designer', atMs: Date.now() }] }], complete: () => pending });
  await new Promise(r => setImmediate(r)); jobs.stop(job.id);
  try { assert.equal(await Promise.race([jobs.settled().then(() => true), new Promise(r => setTimeout(() => r(false), 100))]), true); }
  finally { release('NONE'); await jobs.settled(); }
});
test('control: 6edc49563 excludes LAN and remote llama.cpp without consent', () => {
  for (const url of ['http://192.168.1.20:8080', 'http://model.local:8080', 'https://model.example.invalid']) assert.equal(isLocalProviderEntry({ id: 'x', kind: 'llama-server', url }), false);
  assert.equal(isLocalProviderEntry({ id: 'x', kind: 'llama-server', url: 'http://127.0.0.1:8080' }), true);
});
test('control: a guarded provider refuses missing policy and never falls back to cloud', async () => {
  let calls = 0; let cloudCalls = 0; const lookups = [];
  const provider = guardProvider({ id: 'local', complete: async () => { calls++; return { content: 'NONE' }; } }, { constraintsActive: () => true });
  const cloud = { complete: async () => { cloudCalls++; return { content: 'NONE' }; } };
  const bound = bindImportFactsModel({ engine: { kind: 'local' }, providers: [{ id: 'local', kind: 'llama-server' }, { id: 'remote', kind: 'openai-compatible', baseUrl: 'https://example.invalid' }], activeTextProvider: 'local', getProvider: id => { lookups.push(id); return id === 'local' ? provider : cloud; } });
  await assert.rejects(bound.complete('synthetic', { grammar: '', signal: new AbortController().signal }));
  assert.equal(calls, 0); assert.equal(cloudCalls, 0); assert.deepEqual(lookups, ['local']);
});
test('Privacy Shield archive is fresh for every facts run', async () => {
  resetPrivacyVaults(); setPrivacyShieldEnabled(true); const archives = [];
  try {
    for (let i = 0; i < 2; i++) {
      const bound = bindImportFactsModel({ engine: { kind: 'cloud', provider: 'remote', cloudConsent: true }, providers: [{ id: 'remote', kind: 'openai-compatible', baseUrl: 'https://example.invalid' }], activeTextProvider: 'remote', getProvider: () => ({ complete: async req => { archives.push(shieldVaultFor(req.sessionId, false, 'on')); return { content: 'NONE' }; } }) });
      await bound.complete('synthetic', { grammar: '', signal: new AbortController().signal });
    }
    assert.notEqual(archives[0], archives[1]);
  } finally { setPrivacyShieldEnabled(false); resetPrivacyVaults(); }
});
test('control: offline guard refuses a remote target and permits loopback', () => {
  setOfflineMode(true);
  try { assert.ok(offlineRefusalFor('https://example.invalid')); assert.equal(offlineRefusalFor('http://127.0.0.1:8080'), null); }
  finally { setOfflineMode(false); }
});
async function serverFixture(fn) {
  return fixture(async f => {
    const owner = 'SyntheticC3InheritedOwnerCredential'; const alice = 'SyntheticC3AliceToken'; const bob = 'SyntheticC3BobToken';
    const runtime = { config: f.config, profileStore: f.deps.profileStore, notesStore: f.deps.memoryStore, providerRegistry: { getProvider: () => ({ complete: async () => ({ content: 'SET job=designer', toolCalls: [] }) }) } };
    // Explicit scopes reproduce ONLY dc5a4b980's seven import routes; production candidate is tested separately above.
    const server = await createHttpServer({ runtime, host: '127.0.0.1', port: 0, apiKey: owner, namedTokens: () => [ { name: 'alice', role: 'admin', sha256: hashHttpToken(alice), createdAt: new Date().toISOString() }, { name: 'bob', role: 'viewer', sha256: hashHttpToken(bob), createdAt: new Date().toISOString() } ], routes: routeSpecs.map(([method, path, scope, factory]) => ({ method, path, scope, handler: handlers[factory]() })) });
    const url = `http://127.0.0.1:${server.port}`;
    const request = async (path, token = owner, method = 'GET', body) => { const res = await fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: res.status, body: await res.json() }; };
    try { await fn({ ...f, owner, alice, bob, url, request }); } finally { await server.close(); }
  });
}
async function httpDone(f, token) {
  const started = await f.request('/api/import/facts/start', token, 'POST', { source: 'chatgpt', path: f.d });
  assert.equal(started.status, 200); const id = started.body.job.id;
  for (let i = 0; i < 100; i++) { const r = await f.request(`/api/import/facts/jobs/${id}`, token); if (r.body.job?.state === 'done') return { id, ids: r.body.job.candidates.map(c => c.id) }; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('synthetic import did not settle');
}
test('a named token cannot read a different token job', () => serverFixture(async f => {
  const { id } = await httpDone(f, f.alice); const other = await f.request(`/api/import/facts/jobs/${id}`, f.bob);
  assert.equal(other.status, 404);
}));
test('a subprocess with an inherited owner key cannot approve and save', () => serverFixture(async f => {
  const { id, ids } = await httpDone(f, f.owner);
  const code = "fetch(process.env.C3_URL,{method:'POST',headers:{authorization:'Bearer '+process.env.C3_OWNER,'content-type':'application/json'},body:process.env.C3_BODY}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))";
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', code], { env: { ...process.env, ATOMIC_AGENT_TOOL_CHILD: '1', C3_URL: `${f.url}/api/import/facts/jobs/${id}/save`, C3_OWNER: f.owner, C3_BODY: JSON.stringify({ approvedIds: ids }) }, timeout: 15000 });
  assert.deepEqual({ status: JSON.parse(stdout).status, facts: f.deps.profileStore.list().length }, { status: 403, facts: 0 });
}));
