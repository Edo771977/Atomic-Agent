import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const key = "synthetic-serve-auth-process-key";

it.skipIf(process.platform !== "linux").each(["environment", "file", "generated"] as const)(
  "authenticates a real CLI server using a key from %s",
  async (source) => {
    const stateDir = await mkdtemp(join(tmpdir(), "atag-serve-auth-"));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      ATOMIC_AGENT_STATE_DIR: stateDir,
      ATOMIC_AGENT_OFFLINE: "1",
      ATOMIC_AGENT_ANALYTICS: "off",
    };
    const args = ["--import", "tsx", "src/cli/index.ts", "serve", "--port", "0", "--cwd", stateDir];
    const path = join(stateDir, "operator.key");
    if (source === "environment") env.ATOMIC_AGENT_API_KEY = key;
    if (source === "file") {
      await writeFile(path, key + "\n", { mode: 0o600 });
      args.push("--api-key-file", path);
    }
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    const closed = once(child, "close");
    try {
      const baseUrl = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
          const match = stderr.match(/serve listening on (http:\/\/127\.0\.0\.1:\d+)/);
          if (match?.[1]) resolve(match[1]);
        });
        child.once("error", reject);
        child.once("close", (code) => reject(new Error(`serve exited (${code}): ${stderr}`)));
        AbortSignal.timeout(45_000).addEventListener("abort", () => reject(new Error(`serve did not start: ${stderr}`)));
      });
      const generated = join(stateDir, "serve-api.key");
      const credential = source === "generated" ? (await readFile(generated, "utf8")).trim() : key;
      if (source === "generated") expect((await stat(generated)).mode & 0o777).toBe(0o600);
      const launchEnv = await readFile(`/proc/${child.pid}/environ`, "utf8");
      expect(launchEnv.includes("ATOMIC_AGENT_API_KEY=")).toBe(source === "environment");
      expect(launchEnv.includes(key)).toBe(source === "environment");
      if (source === "file") expect(await readFile(path, "utf8")).toBe(key + "\n");
      expect((await fetch(baseUrl + "/health")).status).toBe(200);
      expect((await fetch(baseUrl + "/v1/models")).status).toBe(401);
      expect((await fetch(baseUrl + "/v1/models", {
        headers: { Authorization: `Bearer ${credential}` },
      })).status).toBe(200);
    } finally {
      child.kill("SIGKILL");
      await closed;
      await rm(stateDir, { recursive: true, force: true });
    }
  },
  55_000,
);
