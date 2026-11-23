import { describe, expect, it } from "vitest";
import { shellNetworkUse, shellNetworkUrls } from "./network-clients.js";

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

const target = "https://docs.example/";
it.each([
  ["-sGd", "q=fixture", target],
  ["-sGdq=fixture", target],
  [target + "?q=$value"],
  [target + "?q=`fixture`"],
  [target + "?q=$__computed__"],
])("classifies curl URL data in %j", (...args) => {
  expect([...shellNetworkUrls("curl", args).values()]).toEqual([true]);
});
it("classifies an inert curl substitution from shell syntax", () => {
  expect([...shellNetworkUrls("curl", [], 'curl "https://docs.example/?q=$(printf fixture)"').values()]).toEqual([true]);
});
it.each([["-K", "example.conf"], ["--config=example.conf"], ["-Kexample.conf"]])("flags opaque curl configuration %j", (...args) => {
  expect([...shellNetworkUrls("curl", args)]).toEqual([["", true]]);
});

it.each([
  ["xh", "http://docs.example:8443/path", "GET", "docs.example:8443/path", "name==fixture"],
  ["http", "http://docs:8080/path", "GET", "docs:8080/path", "name==fixture"],
  ["https", "https://localhost:8080/path", ":8080/path", "name==fixture"],
])("recognizes the schemeless %s destination and query item", (program, expected, ...args) => {
  expect([...shellNetworkUrls(program, args)]).toEqual([[expected, true]]);
});

it("recognizes the destination of aria2c", () => {
  expect([...shellNetworkUrls("aria2c", ["docs:8080/path"])]).toEqual([["http://docs:8080/path", false]]);
});

it.each([
  ["curl", "--output", "out.txt", "--upload-file", "payload.txt", "--header", "https://header.example/", "--user-agent", "foo.example", "--cookie", "cookies.txt", "--user", "account.example", "--referer", "https://referer.example/", "--resolve", "other.example:443:127.0.0.1", target],
  ["wget", "-O", "out.txt", "--load-cookies", "cookies.txt", "--referer", "https://referer.example/", target],
  ["http", "--output", "out.txt", "--auth", "account.example", "GET", target, "X-Test:https://value.example/"],
  ["aria2c", "--out", "out.txt", "--referer", "https://referer.example/", target],
  ["Invoke-WebRequest", "-OutFile", "https://file.example/", "-UserAgent", "https://agent.example/", "-Uri", target],
])("consumes option values before finding the %s destination", (program, ...args) => {
  expect([...shellNetworkUrls(program, args).keys()]).toEqual([target]);
});

it.each([
  ["busybox wget -O out.txt", "wget"],
  ["taskset -c 0 curl", "curl"],
  ["chrt --fifo 10 curl", "curl"],
])("unwraps %s for both classification and URL inspection", (command, program) => {
  const cmd = command + " " + target;
  expect(shellNetworkUse({ cmd })).toEqual({ program, cls: "http" });
  expect([...shellNetworkUrls("", [], cmd).keys()]).toEqual([target]);
});

it.each(["https://$host/path", "https://docs.example:$port/path", "$__computed__"])(
  "requires unscoped consent for a curl destination whose origin is computed in %s",
  (operand) => {
    expect([...shellNetworkUrls("curl", [operand])]).toEqual([["", true]]);
  },
);
