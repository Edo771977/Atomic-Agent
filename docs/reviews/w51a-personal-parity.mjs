import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const evidence = dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'w51a-parity-'));
const previous = 'c9aaeedadad412242b00ed230da369ffb7223f81';
async function load(label, ref) {
  const outfile = join(scratch, `${label}-personal.mjs`);
  await build({ stdin: { contents: 'export * from \"./src/tools/os/shell/shell-command-argv.ts\"; export { ApprovalGate } from \"./src/approval/approval-gate.ts\";', resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile,
    plugins: ref ? [{ name: 'previous-revision', setup(api) { api.onLoad({ filter: /\.ts$/ }, args => {
      const path = relative(root, args.path).replaceAll('\\', '/');
      if (path.startsWith('../')) throw new Error('Unexpected dependency outside repository');
      const result = spawnSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr);
      return { contents: result.stdout, loader: 'ts' };
    }); } }] : [] });
  return import(pathToFileURL(outfile));
}
const before = await load('main', previous), after = await load('w51a');
const flags = ['--cpu-prof', '--heap-prof', '--experimental-test-coverage', '--throw-deprecation', '--trace-exit', '--trace-sigint', '--max-semi-space-size', '--max-http-header-size', '--experimental-detect-module', '--harmony', '--frozen-intrinsics', '--no-experimental-fetch', '--secure-heap', '--zero-fill-buffers', '--run', '-C', '--experimental-default-type', '--no-warnings', '--watch-preserve-output', '--snapshot-blob', '--openssl-legacy-provider', '--experimental-sqlite', '--future-fixture', '--env-file', '--require', '-r', '--input-type', '-i', '--interactive'];
const entries = flags.flatMap(flag => [
  [flag], [flag, 'fixture.js'], [flag, 'fixture', 'fixture.js'], [flag, 'fixture', '-'], [`${flag}=fixture`, '-'], [flag, 'fixture', '-e', 'fixture'],
]);
const changes = [];
const decisionChanges = []; let ruleDecisions = 0;
let decisions = 0;
for (const args of entries) for (const shell of [false, true]) {
  const cmd = shell ? `printf fixture | node ${args.join(' ')}` : 'node';
  const argv = shell ? [] : args;
  const evaluate = module => ({ segments: module.shellRuleSegments(cmd, argv, shell), unreadable: module.shellRunsUnreadableScript(cmd, argv, shell), stdin: module.stdinScriptOf(cmd, argv, shell, 'fixture-command', '/work') });
  const a = evaluate(before), b = evaluate(after); decisions++;
  if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ args, shell, before: a, after: b });
  for (const level of [1, 5]) for (const decision of ['deny', 'ask']) for (const commandPrefix of [['unrelated-fixture'], ['node'], ['printf']]) {
    const compare = (module, parsed) => {
      const gate = new module.ApprovalGate({ level, emit: () => { throw Error('decision-only fixture'); } });
      gate.setRules({ list: () => [{ id:'fixture', source:'user', createdAt:'', category:'shell', commandPrefix, decision }], add: () => { throw Error('read-only'); }, remove: () => false });
      return gate.ruleDecisionFor({ tool:'os.shell.run', category:'shell', sessionId:'fixture', commandSegments:parsed.segments, commandUnreadable:parsed.unreadable });
    };
    const oldDecision = compare(before, a), newDecision = compare(after, b); ruleDecisions++;
    if (oldDecision !== newDecision) decisionChanges.push({ args, shell, level, decision, commandPrefix, before:oldDecision, after:newDecision });
  }

}
const text = readFileSync(join(root, 'src/policy/policy-node-input-routing.test.ts'), 'utf8');
const source = ts.createSourceFile('fixtures.ts', text, ts.ScriptTarget.Latest, true);
const lines = [];
const strings = node => { for (const element of node.elements) if (ts.isStringLiteral(element)) lines.push(element.text); };
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'routingCases' && ts.isArrayLiteralExpression(node.arguments[1])) strings(node.arguments[1]);
  if (ts.isVariableDeclaration(node) && ['ordinary', 'incoming'].includes(node.name.getText(source)) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) strings(node.initializer);
  ts.forEachChild(node, visit);
}
visit(source);
const structuralDifferences = []; let structuralComparisons = 0;
for (const line of lines) for (const dialect of ['posix', 'cmd', 'powershell']) {
  const inspect = module => ({ segments: module.shellRuleSegments(line, [], true, dialect, '/work'), unreadable: module.shellRunsUnreadableScript(line, [], true, dialect, '/work'), stdin: module.stdinScriptOf(line, [], true, 'fixture-input', '/work') });
  const a = inspect(before), b = inspect(after); structuralComparisons++;
  if (JSON.stringify(a) !== JSON.stringify(b)) structuralDifferences.push({ line, dialect, before: a, after: b });
}
const result = { previous, decisions, changes, ruleDecisions, decisionChanges, structuralComparisons, structuralDifferences };
writeFileSync(join(evidence, 'w51a-personal-parity.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ decisions, ruleDecisions, decisionChanges: decisionChanges.length, structuralComparisons, structuralDifferences: structuralDifferences.length, changed: changes.length, examples: changes.slice(0, 3) }));
process.exitCode = changes.length || decisionChanges.length || structuralDifferences.length ? 1 : 0;
