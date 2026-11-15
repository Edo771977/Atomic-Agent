import { describe, expect, it } from "vitest";
import {
  describeForeignGpuUse,
  parseNvidiaComputeApps,
  parseNvidiaMemoryUsage,
  parseNvidiaVramMiB,
  probeNvidiaGpuUsage,
} from "./nvidia-smi-vram.js";

describe("parseNvidiaVramMiB", () => {
  it("parses a single GPU memory.total line", () => {
    expect(parseNvidiaVramMiB("8188\n")).toBe(8188);
  });

  it("returns the maximum across multiple GPUs", () => {
    expect(parseNvidiaVramMiB("8188\n24564\n6144\n")).toBe(24564);
  });

  it("tolerates surrounding whitespace and blank lines", () => {
    expect(parseNvidiaVramMiB("  8188  \n\n  4096\n")).toBe(8188);
  });

  it("returns null for empty output", () => {
    expect(parseNvidiaVramMiB("")).toBeNull();
    expect(parseNvidiaVramMiB("\n\n")).toBeNull();
  });

  it("returns null when nothing parses to a positive number", () => {
    expect(parseNvidiaVramMiB("N/A\n")).toBeNull();
    expect(parseNvidiaVramMiB("0\n")).toBeNull();
  });

  it("ignores trailing units if present (nounits is the happy path)", () => {
    // `--format=...,nounits` strips units, but be defensive: parseInt
    // stops at the first non-digit so "8188 MiB" still yields 8188.
    expect(parseNvidiaVramMiB("8188 MiB\n")).toBe(8188);
  });
});

describe("GPU compute apps (#29: a shared GPU)", () => {
  it("parses pid, used_memory lines and skips unmeasured ones", () => {
    expect(
      parseNvidiaComputeApps("4242, 3072\n 977 , 512 \n\n1300, [N/A]\nnot, a line\n"),
    ).toEqual([
      { pid: 4242, usedMiB: 3072 },
      { pid: 977, usedMiB: 512 },
    ]);
    expect(parseNvidiaComputeApps("")).toEqual([]);
  });

  it("parses memory.used, memory.total per GPU", () => {
    expect(parseNvidiaMemoryUsage("3584, 8192\n100, 24576\nN/A, N/A\n")).toEqual([
      { usedMiB: 3584, totalMiB: 8192 },
      { usedMiB: 100, totalMiB: 24576 },
    ]);
  });

  it("warns with the measured MiB held by processes other than ours", () => {
    const usage = {
      gpus: [{ usedMiB: 4000, totalMiB: 8192 }],
      apps: [
        { pid: 10, usedMiB: 3072 },
        { pid: 11, usedMiB: 512 },
        { pid: 99, usedMiB: 900 },
      ],
    };
    const line = describeForeignGpuUse(usage, [99]);
    expect(line).toContain("other processes hold 3584 MiB on the GPU");
    expect(line).toContain("pid 10, 11");
    expect(line).toContain("the fit uses free VRAM at launch");
    expect(describeForeignGpuUse(usage, [10, 11, 99])).toBeNull();
    expect(describeForeignGpuUse({ gpus: [], apps: [] }, [])).toBeNull();
  });

  it("probes through nvidia-smi and is silent when it is absent", async () => {
    const calls: string[][] = [];
    const run = async (args: readonly string[]) => {
      calls.push([...args]);
      return args[0]!.startsWith("--query-compute-apps") ? "10, 2048\n" : "2100, 8192\n";
    };
    await expect(probeNvidiaGpuUsage(run)).resolves.toEqual({
      gpus: [{ usedMiB: 2100, totalMiB: 8192 }],
      apps: [{ pid: 10, usedMiB: 2048 }],
    });
    expect(calls.map((c) => c[0])).toEqual([
      "--query-gpu=memory.used,memory.total",
      "--query-compute-apps=pid,used_memory",
    ]);
    const absent = async () => {
      throw Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" });
    };
    await expect(probeNvidiaGpuUsage(absent)).resolves.toBeNull();
  });
});
