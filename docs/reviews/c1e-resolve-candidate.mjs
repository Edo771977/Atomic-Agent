import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
const path = "src/agent-profiles/README.md";
const conflicts = execFileSync("git", ["-C", root, "diff", "--name-only", "--diff-filter=U"], { encoding: "utf8" }).trim();
if (conflicts !== path) throw new Error("Unexpected candidate conflict; inspect it manually");
let count = 0;
const text = readFileSync(join(root, path), "utf8").replace(
  /<<<<<<< HEAD\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>>[^\n]*\n/g,
  (_match, head) => {
    count++;
    if (!head.includes("readSettingsAgentProfiles")) throw new Error("Expected the C1d settings documentation");
    return head.replace("Profiles exist only in Fusion: an ordinary turn has no subagent tool to name one with.",
      "Outside Fusion a turn names a profile through subagent.run (ATO-1670, src/tools/subagent/).");
  },
);
if (count !== 1) throw new Error("Expected exactly the known C1d/C1e README conflict");
writeFileSync(join(root, path), text);
