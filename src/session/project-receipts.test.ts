import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { projectCommand } from "../cli/projects-command.js";
import { SecretKeychain } from "../config/secret-store.js";
import { createHash } from "node:crypto";
import { canonicalJson, receiptHash } from "./receipt-signing.js";
import { appendProjectReceipt, createProjectReceiptWriter, verifyProjectReceipts } from "./project-receipts.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "receipts-"));
  dirs.push(dir);
  const credentials = new Map<string, string>();
  const keychain = {
    read: (key: string) => ({ ok: true as const, value: credentials.get(key) ?? null }),
    write: (key: string, value: string) => { credentials.set(key, value); return true; },
  };
  return { dir, append: () => appendProjectReceipt(dir, dir, "check-run-record", { result: "ok" }, keychain), credentials };
}
it("canonicalizes nested keys, newlines and NFC before hashing", () => {
  expect(canonicalJson({ b: 1, a: { x: "e\u0301\r\n" } })).toBe('{"a":{"x":"é\\n"},"b":1}');
  expect(receiptHash({ b: 1, a: "e\u0301\r\n" })).toBe(receiptHash({ a: "é\n", b: 1 }));
  expect(() => canonicalJson({ é: 1, "e\u0301": 2 })).toThrow();
});
it("verifies historical keys and detects tampered payloads and recomputed hashes", async () => {
  const { dir, append, credentials } = setup();
  append(); append(); expect(credentials.size).toBe(1);
  // The generic credential importer accepts uppercase environment-variable accounts.
  expect([...credentials.keys()][0]).not.toMatch(/^[A-Z_][A-Z0-9_]*$/);
  const firstPrivateKey = [...credentials.values()][0]!;
  credentials.clear(); append();
  const path = join(dir, "receipts", readdirSync(join(dir, "receipts"))[0]!, "receipts.ndjson");
  const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows[0].keyId).toBe(rows[1].keyId);
  expect(rows[2].keyId).not.toBe(rows[0].keyId);
  expect(verifyProjectReceipts(dir, dir)).toEqual(["valid", "valid", "valid"]);
  expect(await projectCommand(["verify", dir], { stateDir: () => dir, stdout: () => {} })).toBe(0);
  const secret = [...credentials.values()][0]!;
  for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const bytes = readFileSync(join(file.parentPath, file.name), "utf8");
    for (const pem of [firstPrivateKey, secret]) {
      expect(bytes).not.toContain(pem.trim().split("\n")[1]!);
    }
  }
  const otherFolder = join(dir, "another-project");
  appendProjectReceipt(dir, otherFolder, "artifact-manifest", {}, { read: () => ({ ok: false }), write: () => false });
  const otherKey = readdirSync(join(dir, "receipts")).find(name => !path.includes(name))!;
  writeFileSync(join(dir, "receipts", otherKey, "receipts.ndjson"), JSON.stringify(rows[0]) + "\n");
  expect(verifyProjectReceipts(dir, otherFolder)).toEqual(["bad-signature"]);
  rows[0].payload.result = "no"; rows[1].payload.result = "no";
  rows[1].payloadHash = createHash("sha256").update(canonicalJson(rows[1].payload)).digest("hex");
  rows[2].keyId = "0".repeat(32);
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  expect(verifyProjectReceipts(dir, dir)).toEqual(["hash-mismatch", "bad-signature", "unknown-key"]);
  let output = "";
  expect(await projectCommand(["verify", dir], { stateDir: () => dir, stdout: line => { output += line; } })).toBe(1);
  expect(output).toMatch(/Receipt 1: hash-mismatch\nReceipt 2: bad-signature\nReceipt 3: unknown-key/);
  expect(output).toContain("3 receipts, 0 valid, 3 problems");
});
it("reports a missing key once and preserves each unsigned record", () => {
  const { dir } = setup();
  const messages: string[] = [];
  const writer = createProjectReceiptWriter(dir, { read: () => ({ ok: false }), write: () => false }, text => messages.push(text));
  writer(dir, "artifact-manifest", { files: [] });
  writer(dir, "check-run-record", { ok: false });
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatch(/unsigned/i);
  expect(verifyProjectReceipts(dir, dir)).toEqual(["unsigned", "unsigned"]);
});

it("reports unsigned evidence and the trust boundary in the CLI without opening a real keychain", async () => {
  const { dir } = setup();
  const unavailable = new SecretKeychain(() => null, () => {});
  expect(appendProjectReceipt(dir, dir, "artifact-manifest", { files: [] }, unavailable)).toBe("unsigned");
  let output = "";
  expect(await projectCommand(["verify", dir], { stateDir: () => dir, stdout: s => { output += s; } })).toBe(1);
  expect(output).toContain("unsigned"); expect(output).toMatch(/same user/i);
  expect(readFileSync(join(process.cwd(), "src/cli/README.md"), "utf8")).toMatch(/same user/i);
});
