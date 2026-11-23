import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Read operator consent from the controlling terminal, independent of stdin. */
export async function readLearnFingerprint(preview: string): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const input = createReadStream(process.platform === "win32" ? "CONIN$" : "/dev/tty", { encoding: "utf8" });
  const lines = createInterface({ input, terminal: false });
  try {
    process.stdout.write(`${preview}\nType the displayed fingerprint to approve: `);
    for await (const line of lines) return line.trim().toLowerCase();
    return null;
  } catch {
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}
