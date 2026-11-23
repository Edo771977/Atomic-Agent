import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Apply an owner-only DACL, using the same current-user identity as core's ACL check. */
function restrictWindowsAccess(path: string): void {
  const root = process.env.SystemRoot;
  if (!root) throw new Error("Cannot locate Windows PowerShell to protect the serve key.");
  const encodedPath = Buffer.from(path, "utf16le").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + encodedPath + "'))",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = Get-Acl -LiteralPath $path",
    "if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid) { exit 1 }",
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($rule in $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) { $acl.RemoveAccessRuleSpecific($rule) }",
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))",
    "Set-Acl -LiteralPath $path -AclObject $acl",
  ].join("\n");
  execFileSync(join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { stdio: "ignore", timeout: 5_000, windowsHide: true });
}

function keyDirectory(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory = join(realpathSync(dirname(path)), basename(path));
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = lstatSync(directory);
  if (!entry.isDirectory()) throw new Error("The serve key directory must be a real directory.");
  if (process.platform === "win32") {
    restrictWindowsAccess(directory);
  } else if (entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o700) {
    throw new Error("The serve key directory must be owned by the current user with mode 0700.");
  }
  return directory;
}

export function createServeKeyFile(directory: string, token: string): string {
  const path = join(keyDirectory(directory), `serve-key-${process.pid}-${randomBytes(16).toString("hex")}`);
  const fd = openSync(path, "wx", 0o600);
  try {
    try {
      // Restrict the empty file before writing any secret bytes.
      if (process.platform === "win32") restrictWindowsAccess(path);
      else fchmodSync(fd, 0o600);
      writeFileSync(fd, token);
    } finally {
      closeSync(fd);
    }
    return path;
  } catch (error) {
    unlinkSync(path);
    throw error;
  }
}
