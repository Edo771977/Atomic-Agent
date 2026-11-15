import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Parse the output of
 * `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`.
 * Each non-empty line is one GPU's total memory in MiB. Returns the
 * maximum across GPUs (matching the largest-VRAM device an `auto` pick
 * would offload to), or `null` when no line parses to a positive
 * number. Pure — no IO.
 */
export function parseNvidiaVramMiB(output: string): number | null {
  let maxMiB = 0;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const mib = Number.parseInt(trimmed, 10);
    if (Number.isFinite(mib) && mib > maxMiB) maxMiB = mib;
  }
  return maxMiB > 0 ? maxMiB : null;
}

/**
 * Best-effort probe of total NVIDIA VRAM via `nvidia-smi`. Used as a
 * pre-download fallback on Linux/Windows when the llama.cpp backend is
 * not yet on disk and `--list-devices` therefore cannot run, so the
 * onboarding model list can still flag models that will not fit on the
 * GPU. Returns the largest single-GPU `memory.total` in MiB, or `null`
 * when `nvidia-smi` is absent, errors, or reports nothing parseable.
 * NVIDIA-only by design — other vendors stay null until the backend
 * lands and the Vulkan enumeration covers them. Never throws.
 */
export async function probeNvidiaVramMiB(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { timeout: 4000, maxBuffer: 256 * 1024 },
    );
    return parseNvidiaVramMiB(stdout);
  } catch {
    return null;
  }
}

/** One process holding GPU memory, as `nvidia-smi --query-compute-apps` measured it. */
export interface NvidiaComputeApp {
  pid: number;
  usedMiB: number;
}

/** One GPU's `memory.used` / `memory.total`, MiB. */
export interface NvidiaGpuMemory {
  usedMiB: number;
  totalMiB: number;
}

/** What `nvidia-smi` measured on the GPUs: per-device memory and the processes holding it. */
export interface NvidiaGpuUsage {
  gpus: NvidiaGpuMemory[];
  apps: NvidiaComputeApp[];
}

function csvInts(line: string): number[] | null {
  const cells = line.split(",").map((c) => c.trim());
  const out: number[] = [];
  for (const cell of cells) {
    if (!/^\d+/.test(cell)) return null;
    out.push(Number.parseInt(cell, 10));
  }
  return out;
}

/**
 * Parse `nvidia-smi --query-compute-apps=pid,used_memory
 * --format=csv,noheader,nounits`. A line whose memory is not measured
 * (`[N/A]`, as under Windows WDDM) is skipped rather than guessed. Pure.
 */
export function parseNvidiaComputeApps(output: string): NvidiaComputeApp[] {
  const apps: NvidiaComputeApp[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const cells = csvInts(line);
    if (cells === null || cells.length < 2) continue;
    apps.push({ pid: cells[0]!, usedMiB: cells[1]! });
  }
  return apps;
}

/** Parse `nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits`. Pure. */
export function parseNvidiaMemoryUsage(output: string): NvidiaGpuMemory[] {
  const gpus: NvidiaGpuMemory[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const cells = csvInts(line);
    if (cells === null || cells.length < 2 || !(cells[1]! > 0)) continue;
    gpus.push({ usedMiB: cells[0]!, totalMiB: cells[1]! });
  }
  return gpus;
}

/** Runs `nvidia-smi` with these arguments and resolves with its stdout. */
export type NvidiaSmiRun = (args: readonly string[]) => Promise<string>;

const runNvidiaSmi: NvidiaSmiRun = async (args) =>
  (
    await execFileAsync("nvidia-smi", [...args], {
      timeout: 4000,
      maxBuffer: 256 * 1024,
    })
  ).stdout;

/**
 * Best-effort measurement of who holds NVIDIA GPU memory: per-GPU
 * `memory.used`/`memory.total` and `--query-compute-apps`. `null` when
 * `nvidia-smi` is absent or fails (another vendor, no driver): callers
 * skip the check silently. Never throws.
 */
export async function probeNvidiaGpuUsage(
  run: NvidiaSmiRun = runNvidiaSmi,
): Promise<NvidiaGpuUsage | null> {
  try {
    const gpus = parseNvidiaMemoryUsage(
      await run(["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"]),
    );
    const apps = parseNvidiaComputeApps(
      await run(["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]),
    );
    return { gpus, apps };
  } catch {
    return null;
  }
}

/**
 * The `models start` warning when processes other than ours (`ownPids`:
 * the model servers this install runs) hold GPU memory: the launch's fit
 * uses the free VRAM at that moment, so a shared GPU gets a smaller
 * context and fewer worker slots, and the model runs slower while the
 * other work computes. Measured numbers only; `null` when nothing else
 * holds any. Pure.
 */
export function describeForeignGpuUse(
  usage: NvidiaGpuUsage,
  ownPids: readonly number[],
): string | null {
  const own = new Set(ownPids);
  const others = usage.apps.filter((a) => !own.has(a.pid) && a.usedMiB > 0);
  if (others.length === 0) return null;
  const heldMiB = others.reduce((sum, a) => sum + a.usedMiB, 0);
  const pids = others.map((a) => a.pid).join(", ");
  const gpu = usage.gpus.length === 1 ? usage.gpus[0]! : null;
  const of = gpu === null ? "" : ` (${gpu.usedMiB} of ${gpu.totalMiB} MiB in use)`;
  return (
    `note: other processes hold ${heldMiB} MiB on the GPU${of} (pid ${pids}); ` +
    "the fit uses free VRAM at launch, so the context and worker slots are smaller " +
    "and generation can be slower while they run"
  );
}
