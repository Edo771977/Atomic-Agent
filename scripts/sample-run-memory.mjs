#!/usr/bin/env node
// Issue #106: sample a process's memory from outside, every second, into
// NDJSON, and stop it once its private memory passes a limit, long before
// the machine runs out. The process is a command run here (after `--`,
// with this script's stdin, stdout and stderr) or one already running
// (`--pid`). Its children are counted too: a launcher (a .cmd shim) may
// start the process that grows.
//
//   node scripts/sample-run-memory.mjs --output samples.ndjson [--stop-private-mb N] [--interval-ms 1000] -- <command> [args...]
//   node scripts/sample-run-memory.mjs --output samples.ndjson [--stop-private-mb N] --pid <pid>
//
// Windows: one long-lived PowerShell child prints Get-Process's
// PrivateMemorySize64 and WorkingSet64 for the tree each interval. Linux:
// /proc/<pid>/status (resident VmRSS; private RssAnon + VmSwap). macOS: ps
// (resident only, private null). Exit: the command's own code (1 when it
// ended on a signal), 0 when an attached process ends, 4 when stopped over
// the limit, 2 on a usage error. Node built-ins only.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: sample-run-memory.mjs --output <file> [--stop-private-mb N] [--interval-ms N] (--pid <pid> | -- <command> [args...])';
export const STOPPED_EXIT = 4;
const MB = 1024 * 1024;

export function parseArgs(argv) {
  const opts = { output: null, stopPrivateMb: null, intervalMs: 1000, pid: null, command: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { opts.command = argv.slice(i + 1); break; }
    const value = argv[i + 1];
    i += 1;
    if (arg === '--output') opts.output = value ?? null;
    else if (arg === '--stop-private-mb') opts.stopPrivateMb = Number(value);
    else if (arg === '--interval-ms') opts.intervalMs = Number(value);
    else if (arg === '--pid') opts.pid = Number(value);
    else return { error: `unknown argument ${arg}` };
  }
  if (!opts.output) return { error: '--output is required' };
  if (opts.stopPrivateMb !== null && !(Number.isFinite(opts.stopPrivateMb) && opts.stopPrivateMb > 0)) return { error: '--stop-private-mb takes a number of MB above 0' };
  if (!(Number.isInteger(opts.intervalMs) && opts.intervalMs >= 50)) return { error: '--interval-ms takes an integer of at least 50' };
  if ((opts.pid === null) === (opts.command === null || opts.command.length === 0)) return { error: 'give either --pid or a command after --' };
  if (opts.pid !== null && !(Number.isInteger(opts.pid) && opts.pid > 0)) return { error: '--pid takes a process id' };
  return opts;
}

// --- Linux: /proc --------------------------------------------------------

function linuxStatus(pid) {
  let text;
  try { text = readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { return null; }
  const field = (name) => {
    const m = new RegExp(`^${name}:\\s+(\\S+)`, 'm').exec(text);
    return m ? m[1] : null;
  };
  if (field('State') === 'Z') return null;
  const kb = (name) => Number(field(name) ?? 0) * 1024;
  return { pid, ppid: Number(field('PPid')), name: field('Name'), privateBytes: kb('RssAnon') + kb('VmSwap'), residentBytes: kb('VmRSS') };
}

function linuxChildren(pid) {
  const children = [];
  let tasks = [];
  try { tasks = readdirSync(`/proc/${pid}/task`); } catch { return children; }
  for (const tid of tasks) {
    try {
      for (const c of readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim().split(/\s+/)) if (c) children.push(Number(c));
    } catch { /* thread gone */ }
  }
  return children;
}

function linuxTree(root) {
  // /proc/<pid>/task/<tid>/children depends on the kernel's procfs
  // configuration. Fall back to parent IDs when that index is absent.
  if (!existsSync(`/proc/self/task/${process.pid}/children`)) {
    const rows = readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .map((entry) => linuxStatus(Number(entry)))
      .filter((row) => row !== null);
    return treeOf(rows, root);
  }
  const out = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const status = linuxStatus(pid);
    if (status === null) continue;
    out.push(status);
    queue.push(...linuxChildren(pid));
  }
  return out;
}

// --- macOS: ps -------------------------------------------------------------

function psTree(root) {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' });
  const rows = (r.stdout ?? '').split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: m[4].trim(), privateBytes: null, residentBytes: Number(m[3]) * 1024 }));
  return treeOf(rows, root);
}

function treeOf(rows, root) {
  const out = [];
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((r) => r.pid === pid);
    if (!row) continue;
    out.push(row);
    for (const r of rows) if (r.ppid === pid && r.pid !== pid) queue.push(r.pid);
  }
  return out;
}

// --- Windows: one long-lived PowerShell loop ---------------------------------

/** The loop: refresh the tree from Win32_Process every 5 rounds, read each process with Get-Process every round. */
export function windowsSamplerScript(root, intervalMs) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$root = ${Number(root)}`,
    '$tree = @($root); $parent = @{}; $round = 0',
    'while ($true) {',
    '  if ($round % 5 -eq 0) {',
    '    $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)',
    '    $tree = @($root); $i = 0',
    '    while ($i -lt $tree.Count) {',
    '      $p = $tree[$i]',
    '      foreach ($c in $all) { $id = [int]$c.ProcessId; if ([int]$c.ParentProcessId -eq $p -and $tree -notcontains $id) { $tree += $id; $parent[$id] = $p } }',
    '      $i++',
    '    }',
    '  }',
    '  $round++',
    '  foreach ($id in $tree) {',
    '    $p = Get-Process -Id $id',
    '    if ($p) { $pp = $parent[$id]; if ($null -eq $pp) { $pp = 0 }; [Console]::Out.WriteLine("P $($p.Id) $pp $($p.PrivateMemorySize64) $($p.WorkingSet64) $($p.ProcessName)") }',
    '  }',
    '  [Console]::Out.WriteLine("E")',
    '  [Console]::Out.Flush()',
    `  Start-Sleep -Milliseconds ${Number(intervalMs)}`,
    '}',
  ].join('\n');
}

function startWindowsSampler(root, intervalMs, onSample) {
  const encoded = Buffer.from(windowsSamplerScript(root, intervalMs), 'utf16le').toString('base64');
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  let buffered = '';
  let rows = [];
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      const m = /^P (\d+) (\d+) (\d+) (\d+) ?(.*)$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[5], privateBytes: Number(m[3]), residentBytes: Number(m[4]) });
      else if (line === 'E') { onSample(rows); rows = []; }
    }
  });
  ps.on('error', (err) => process.stderr.write(`sample-run-memory: PowerShell sampler failed: ${err.message}\n`));
  return () => { try { ps.kill(); } catch { /* gone */ } };
}

/** Each interval, `onSample(rows)` with the tree under `root` (empty once it is gone). Returns a stop. */
function startSampling(root, intervalMs, onSample) {
  if (process.platform === 'win32') return startWindowsSampler(root, intervalMs, onSample);
  const read = process.platform === 'linux' ? linuxTree : psTree;
  const tick = () => onSample(read(root));
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}

function killTree(rows, root) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(root), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  for (const row of [...rows].reverse()) {
    try { process.kill(row.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  try { process.kill(root, 'SIGKILL'); } catch { /* gone */ }
}

/** Windows cannot spawn a .cmd/.bat without a shell: find what `command` names on PATH. */
function windowsLaunch(command, args) {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const candidates = (name) => (extname(name) ? [name] : exts.map((e) => name + e));
  const dirs = isAbsolute(command) || command.includes('\\') || command.includes('/') ? [''] : ['', ...(process.env.PATH ?? '').split(delimiter)];
  for (const dir of dirs) {
    for (const file of candidates(dir ? join(dir, command) : command)) {
      if (!existsSync(file)) continue;
      if (!/\.(cmd|bat)$/i.test(file)) return { file, args, shell: false };
      const bad = args.find((a) => /["%]/.test(a));
      if (bad !== undefined) throw new Error(`cannot pass ${JSON.stringify(bad)} through cmd.exe to ${file}`);
      return { file: `"${file}"`, args: args.map((a) => `"${a}"`), shell: true };
    }
  }
  return { file: command, args, shell: false };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if ('error' in opts) {
    process.stderr.write(`sample-run-memory: ${opts.error}\n${USAGE}\n`);
    return 2;
  }
  const fd = openSync(opts.output, 'a');
  const started = Date.now();
  const write = (record) => { try { writeSync(fd, `${JSON.stringify({ elapsedMs: Date.now() - started, ...record })}\n`); } catch { /* full disk */ } };
  const limitBytes = opts.stopPrivateMb === null ? null : Math.round(opts.stopPrivateMb * MB);

  let child = null;
  let root = opts.pid;
  if (opts.command !== null) {
    const [command, ...args] = opts.command;
    let launch;
    try {
      launch = process.platform === 'win32' ? windowsLaunch(command, args) : { file: command, args, shell: false };
    } catch (err) {
      process.stderr.write(`sample-run-memory: ${err.message}\n`);
      return 2;
    }
    child = spawn(launch.file, launch.args, { stdio: 'inherit', shell: launch.shell });
    root = child.pid;
    if (root === undefined) {
      const err = await new Promise((r) => child.once('error', r));
      process.stderr.write(`sample-run-memory: cannot start ${command}: ${err.message}\n`);
      return 2;
    }
  }
  write({ kind: 'start', pid: root, attached: child === null, platform: process.platform, intervalMs: opts.intervalMs, stopPrivateBytes: limitBytes, ...(child ? { program: opts.command[0], argCount: opts.command.length - 1 } : {}) });

  return new Promise((resolve) => {
    let stopped = false;
    let finished = false;
    let stopSampling = () => {};
    const finish = (code, signal = null) => {
      if (finished) return;
      finished = true;
      stopSampling();
      write({ kind: 'end', code, signal });
      resolve(stopped ? STOPPED_EXIT : code ?? 1);
    };
    if (child) child.on('exit', (code, signal) => finish(code ?? (signal ? 1 : 0), signal));
    stopSampling = startSampling(root, opts.intervalMs, (rows) => {
      if (finished) return;
      if (rows.length === 0) {
        if (!child) finish(0);
        return;
      }
      const sum = (key) => (rows.some((r) => r[key] === null) ? null : rows.reduce((n, r) => n + r[key], 0));
      const privateBytes = sum('privateBytes');
      const residentBytes = sum('residentBytes');
      const record = { pid: root, privateBytes, residentBytes, processes: rows };
      write({ kind: 'sample', ...record });
      const measured = privateBytes ?? residentBytes;
      if (stopped || limitBytes === null || measured <= limitBytes) return;
      stopped = true;
      write({ kind: 'stop', reason: 'private-over-limit', limitBytes, ...record });
      process.stderr.write(`sample-run-memory: private memory ${(measured / MB).toFixed(0)} MB is over ${opts.stopPrivateMb} MB; stopping pid ${root} and its children\n`);
      killTree(rows, root);
      if (!child) finish(STOPPED_EXIT);
    });
  });
}

// Run only as a script; the test imports nothing that starts sampling.
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(resolvePath(process.argv[1]), fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code), (err) => { process.stderr.write(`sample-run-memory: ${err.stack ?? err}\n`); process.exit(1); });
}
