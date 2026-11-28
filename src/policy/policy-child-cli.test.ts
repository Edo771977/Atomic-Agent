import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

describe("policy in a real CLI child", () => {
  it("allows ordinary invocation, retains inherited deny and keeps policy show operator-only", () => {
    const root = mkdtempSync(join(tmpdir(), "policy-cli-child-"));
    const env = { ...process.env, ATOMIC_AGENT_TOOL_CHILD: "1", ATOMIC_AGENT_STATE_DIR: join(root, "other"),
      ATOMIC_AGENT_POLICY_STATE_DIR: root, ATOMIC_AGENT_POLICY_SYSTEM_PATH: join(root, "admin.json"), ProgramData: root, ATOMIC_POLICY_URL: "" };
    const script = `import { ToolRegistry } from './src/tools/tool-registry.ts';
      import { compressToolResult } from './src/compressor/result-compressor.ts';
      const r=new ToolRegistry(); r.register({name:'os.fs.write',description:'fixture',readonly:false,
        run:async()=>compressToolResult({tool:'os.fs.write',status:'ok',output:'ordinary'})});
      try { const out=await r.invoke('os.fs.write',{path:'ordinary.txt'}, {sessionId:'fixture',stepIndex:0,workingDir:process.env.ATOMIC_AGENT_POLICY_STATE_DIR,signal:new AbortController().signal});console.log(out.status); }
      catch(e) { if(!String(e).includes('policy')) throw e;console.log('blocked'); }`;
    const invoke = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    try {
      const ordinary = invoke(); expect(ordinary.status).toBe(0); expect(ordinary.stdout.trim()).toBe("ok");
      writeFileSync(join(root, "policy.json"), JSON.stringify({ rules: [{ action: "edit", resource: "*ordinary.txt", effect: "deny" }] }));
      const denied = invoke(); expect(denied.status).toBe(0); expect(denied.stdout.trim()).toBe("blocked");
      const inspect = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
        "import { policyCommand } from './src/cli/policy-command.ts'; process.exitCode=await policyCommand(['show']);"], { env, encoding: "utf8", windowsHide: true, timeout: 10_000 });
      expect(inspect.status).toBe(1); expect(inspect.stderr).toContain("operator"); expect(inspect.stdout).not.toContain("ordinary.txt");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
