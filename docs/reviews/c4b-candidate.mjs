import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const candidate = process.env.C4_CANDIDATE_ROOT;
assert.ok(candidate, 'Set C4_CANDIDATE_ROOT to the prepared -Through b candidate');
const root = mkdtempSync(join(tmpdir(), 'c4b-audit-'));
process.env.ATOMIC_AGENT_STATE_DIR = join(root, 'state');
const load = p => import(pathToFileURL(join(candidate, p)).href);
const { FileIndex } = await load('src/tools/files/file-index.ts');
const { loadSqliteVec } = await load('src/tools/files/file-vec-extension.ts');
const { rerankerFromEnv, createHttpReranker, applyRerank } = await load('src/tools/files/file-rerank.ts');
const { runWithProviderPolicy } = await load('src/llm/provider-policy.ts');
const { installTransportDeadlines, resetTransportDeadlines } = await load('src/llm/transport-deadlines.ts');
const { setOfflineNetwork, egressSnapshot, resetOfflineNetworkForTests } = await load('src/llm/offline-network.ts');
const { maskSecrets } = await load('src/error-reporting/secret-detector.ts');
const { Database: DatabaseCtor } = await load('src/native/load-better-sqlite3.ts');
after(() => { resetOfflineNetworkForTests(); resetTransportDeadlines(); rmSync(root, { recursive: true, force: true }); });
let serial = 0;
const fixture = () => { const dir = join(root, String(++serial)); const docs = join(dir, 'docs'); mkdirSync(docs, { recursive: true }); writeFileSync(join(docs, 'one.txt'), 'keyword cat'); writeFileSync(join(docs, 'two.txt'), 'keyword truck'); return { dir, docs }; };
const open = (f, options = {}) => new FileIndex({ dbFile: join(f.dir, 'index.sqlite'), validation: { systemDirs: [], home: join(f.dir, 'home') }, ...options });

test('loader must reject an unpinned agent-writable sqlite-vec package before executing its JavaScript or requesting a native load', async () => {
  const packageDir = resolve(candidate, 'node_modules', 'sqlite-vec');
  assert.ok(packageDir.startsWith(resolve(candidate) + (process.platform === 'win32' ? '\\' : '/')));
  assert.equal(realpathSync(join(candidate, 'node_modules')), join(realpathSync(candidate), 'node_modules'), 'Do not use a linked/shared node_modules directory');
  assert.ok(!existsSync(packageDir), 'Use a fresh npm ci candidate without sqlite-vec; never overwrite an installed package');
  mkdirSync(packageDir);
  try {
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'sqlite-vec', type: 'module', exports: './index.js' }));
    // Harmless marker and fake DB: no native code is compiled or loaded.
    writeFileSync(join(packageDir, 'index.js'), `globalThis.c4PackageExecuted=true;export function load(db){db.loadExtension(new URL('./agent-writable-fixture.dll',import.meta.url).pathname);}`);
    const loaderUrl = pathToFileURL(join(candidate, 'src/tools/files/file-vec-extension.ts')).href;
    const code = `const {loadSqliteVec}=await import(${JSON.stringify(loaderUrl)});const paths=[];const result=await loadSqliteVec({loadExtension:p=>paths.push(p),prepare:()=>({get:()=>({v:'fixture'})})});process.stdout.write(JSON.stringify({executed:globalThis.c4PackageExecuted===true,paths,result}));`;
    const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: candidate });
    const observed = JSON.parse(child.stdout);
    assert.deepEqual(observed, { executed: false, paths: [], result: false });
  } finally { rmSync(packageDir, { recursive: true, force: true }); }
});

test('control: missing extension package is an optional failure', async () => {
  assert.equal(await loadSqliteVec({ prepare() { throw Error('missing extension must not query'); } }), false);
});

for (const mode of ['disabled', 'false', 'throws']) {
  test(`control: ${mode} extension retains existing keyword and semantic fallback`, async () => {
    const f = fixture(); const index = open(f, { vectorExtension: mode === 'disabled' ? false : async () => { if (mode === 'throws') throw Error('fixture load failed'); return false; }, embedding: () => ({ model: 'fixture', dim: 2, embed: async r => ({ model: 'fixture', vector: new Float32Array(/cat|kitten/.test(r.text) ? [1, 0] : [0, 1]) }) }) });
    try { await index.addFolder(f.docs); await index.idle(); assert.equal((await index.search({ query: 'keyword' })).length, 2); assert.ok((await index.search({ query: 'kitten' })).some(hit => hit.path.endsWith('one.txt'))); }
    finally { await index.close(); }
  });
}

test('control: default reranker is off and a public endpoint is refused', () => {
  assert.equal(rerankerFromEnv({}), null); assert.equal(rerankerFromEnv({ ATOMIC_AGENT_RERANK_URL: 'https://rerank.example.com' }), null);
});

test('LAN reranker configuration must require remote admission rather than be treated as this computer', () => {
  const urls = ['http://192.168.1.20:8081', 'http://gpu-box.local:8081', 'http://100.64.1.2:8081'];
  assert.deepEqual(urls.map(url => rerankerFromEnv({ ATOMIC_AGENT_RERANK_URL: url }) === null), [true, true, true]);
});

test('reranker must enforce the active provider/host/egress constraint before HTTP', async () => {
  const bodies = []; const server = createServer(async (req, res) => { let body = ''; for await (const part of req) body += part; bodies.push(body); res.setHeader('content-type', 'application/json'); res.end('{"results":[{"index":0,"relevance_score":1}]}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const reranker = rerankerFromEnv({ ATOMIC_AGENT_RERANK_URL: `http://127.0.0.1:${server.address().port}` }); assert.ok(reranker);
    const deny = { key: 'deny-all', matchedDir: root, allowedProviders: [], allowedProviderHosts: [], allowedEgress: [], allows: () => false, allowsEgress: () => false };
    await runWithProviderPolicy(deny, () => reranker.rerank('private query', ['private document', 'other document']), { sessionId: 'audit' });
    assert.equal(bodies.length, 0);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('detected and runtime-known secrets must be masked before a remote reranker seam', async () => {
  const key = 'sk-proj-' + 'aB1234567890'.repeat(5); const opaque = 'opaque-fixture-rerank-283d9'; const known = [{ label: 'fixture', value: opaque }];
  assert.notEqual(maskSecrets(key), key); assert.notEqual(maskSecrets(opaque, known), opaque);
  const bodies = []; const reranker = createHttpReranker({ url: 'http://gpu-box.local:8081', fetch: async (_url, init) => { bodies.push(String(init.body)); return new Response('{"results":[{"index":0,"relevance_score":1}]}'); } });
  await reranker.rerank(key, [opaque, 'other']); assert.equal(bodies.length, 1); assert.ok(!bodies[0].includes(key)); assert.ok(!bodies[0].includes(opaque));
});

test('control: failed reranker preserves original order', async () => {
  const items = ['first', 'second']; const result = await applyRerank(createHttpReranker({ url: 'http://127.0.0.1:1', fetch: async () => { throw Error('fixture unavailable'); } }), 'query', items, items);
  assert.deepEqual(result.map(r => r.item), items);
});

test('control: process offline dispatcher blocks a nonlocal reranker before connection', async () => {
  installTransportDeadlines(); setOfflineNetwork(true);
  try { const before = egressSnapshot(); const result = await createHttpReranker({ url: 'http://192.0.2.1:8081', timeoutMs: 1000 }).rerank('fixture', ['one', 'two']); assert.equal(result, null); const after = egressSnapshot(); assert.ok(after.requestsBlocked > before.requestsBlocked); assert.equal(after.requestsOut, before.requestsOut); }
  finally { setOfflineNetwork(false); }
});

test('control: offline permits loopback and blocks its redirect to a nonlocal host', async () => {
  let redirect = false; const server = createServer((_req, res) => { if (redirect) { res.writeHead(307, { location: 'http://192.0.2.1:8081/v1/rerank' }); res.end(); } else { res.setHeader('content-type', 'application/json'); res.end('{"results":[{"index":0,"relevance_score":1}]}'); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); installTransportDeadlines(); setOfflineNetwork(true);
  try { const reranker = rerankerFromEnv({ ATOMIC_AGENT_RERANK_URL: `http://127.0.0.1:${server.address().port}` }); assert.deepEqual(await reranker.rerank('fixture', ['one', 'two']), [{ index: 0, score: 1 }]); redirect = true; const before = egressSnapshot(); assert.equal(await reranker.rerank('fixture', ['one', 'two']), null); assert.ok(egressSnapshot().requestsBlocked > before.requestsBlocked); assert.equal(egressSnapshot().requestsOut, before.requestsOut); }
  finally { setOfflineNetwork(false); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('control: candidate adds no package dependency, lock change or install script', async () => {
  const child = await promisify(execFile)('git', ['diff', '933e083818c3cc9d3cf8c2f1416324ff653baf11', 'HEAD', '--', 'package.json', 'package-lock.json'], { cwd: candidate }); assert.equal(child.stdout, '');
});
