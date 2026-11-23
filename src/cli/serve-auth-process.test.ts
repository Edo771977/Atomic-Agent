import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const key = "synthetic-serve-auth-process-key";

it.skipIf(process.platform !== "linux").each(["environment", "file", "generated", "stdin", "file-delete"] as const)(
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
    if (source === "stdin") args.push("--api-key-stdin");
    if (source === "file" || source === "file-delete") {
      await writeFile(path, key + "\n", { mode: 0o600 });
      args.push("--api-key-file", path);
      if (source === "file-delete") args.push("--api-key-file-delete");
    }
    const child = spawn(process.execPath, args, { env, stdio: [source === "stdin" ? "pipe" : "ignore", "ignore", "pipe"] });
    const closed = once(child, "close");
    try {
      const fdPath = "/proc/" + child.pid + "/fd/0";
      const originalInput = source === "stdin" ? await readlink(fdPath) : undefined;
      if (source === "stdin") {
        child.stdin!.on("error", () => {});
        child.stdin!.write(key + "\r\n"); // Keep the writer open so waiting for EOF would fail.
      }
      const baseUrl = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
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
      if (source === "stdin") {
        const commandLine = await readFile("/proc/" + child.pid + "/cmdline", "utf8");
        expect(commandLine).not.toContain(key);
        const currentInput = await readlink(fdPath).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== "ENOENT") throw err;
          return undefined;
        });
        expect(currentInput).not.toBe(originalInput);
        expect(currentInput).toBe("/dev/null");
      }
      if (source === "file-delete") await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
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

it.each([
  ["closed", "", /no API key line/i],
  ["empty", "\n", /no API key line/i],
  ["unterminated", "synthetic-key-without-newline", /newline/i],
  ["oversized", "s".repeat(4097) + "\n", /4096 bytes/i],
  ["short", "synthetic\n", /at least 16/i],
  ["invalid", "synthetic invalid key\n", /printable ASCII/i],
] as const)("rejects %s stdin before starting serve", async (_type, input, message) => {
  const dir = await mkdtemp(join(tmpdir(), "atag-stdin-error-"));
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", "serve", "--api-key-stdin"], {
      env: { PATH: process.env.PATH, ATOMIC_AGENT_STATE_DIR: dir, ATOMIC_AGENT_OFFLINE: "1" },
      stdio: ["pipe", "ignore", "pipe"],
    });
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", part => { stderr += part; });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    expect((await closed)[0]).toBe(1);
    expect(stderr).toMatch(message);
    expect(stderr).not.toContain("serve listening");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(process.platform !== "linux")("reserves fd 0 across listen, close and listen on the same port", async () => {
  const script = [
    'import { readlinkSync } from "node:fs";',
    'import { once } from "node:events";',
    'import { createServer } from "node:net";',
    'import { readServeKeyFromStdin } from "./src/cli/serve-api-key-input.ts";',
    'const result = await readServeKeyFromStdin();',
    'if ("error" in result) throw new Error(result.error);',
    'if (readlinkSync("/proc/self/fd/0") !== "/dev/null") throw new Error("fd 0 was not reserved");',
    'const server = createServer();',
    'server.listen(0, "127.0.0.1");',
    'await once(server, "listening");',
    'const { port } = server.address();',
    'server.close();',
    'await once(server, "close");',
    'server.listen(port, "127.0.0.1");',
    'await once(server, "listening");',
    'server.close();',
    'await once(server, "close");',
  ].join("\n");
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", part => { stderr += part; });
  try {
    child.stdin.end(key + "\n");
    expect((await closed)[0], stderr).toBe(0);
  } finally {
    child.kill();
  }
});
