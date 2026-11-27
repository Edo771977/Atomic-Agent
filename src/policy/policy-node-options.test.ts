import { describe, expect, it } from "vitest";
import { toolCallTarget } from "./policy-targets.js";
import { evaluatePolicy, type EffectivePolicy } from "./policy-evaluator.js";

const values = ["--env-file", "--env-file-if-exists", "--watch-path", "--disable-warning", "--dns-result-order", "--localstorage-file", "--allow-fs-read", "--allow-fs-write", "--stack-size", "--title", "--conditions"];
const operational = ["--experimental-vm-modules", "--preserve-symlinks", "--preserve-symlinks-main", "--test-only", "--permission", "--experimental-permission", "--experimental-require-module", "--no-experimental-require-module", "--no-addons"];
function effects(args: string[]) {
  const target = toolCallTarget("os.shell.run", { cmd: "node", args })!;
  return (["deny", "ask"] as const).map(effect => {
    const policy: EffectivePolicy = { sources: [], mcpAllowlists: [], rules: [{ source: "system", index: 0, action: "shell", resource: "unrelated-fixture*", effect }] };
    return evaluatePolicy(policy, "shell", target.resources, target)?.effect ?? null;
  });
}
describe("Node code and operational option boundaries", () => {
  it.each(values)("consumes a separate or attached value for %s", option => {
    expect(effects([option, "fixture", "fixture.js", "-e"])).toEqual([null, null]);
    expect(effects([`${option}=fixture`, "fixture.js"])).toEqual([null, null]);
    expect(effects([option, "fixture", "-e", "void 0"])).toEqual(["deny", "ask"]);
  });
  it.each(operational)("retains operational %s", option => expect(effects([option, "fixture.js"])).toEqual([null, null]));
  it.each([
    ["-e", "void 0"], ["-p", "fixture"], ["--eval=void 0"], ["--print", "fixture"],
    ["-rdata:text/javascript,void 0"],
    ...["-r", "--require", "--import", "--loader", "--experimental-loader"].map(flag => [flag, "data:text/javascript,void 0"]),
    ...["--require", "--import", "--loader", "--experimental-loader"].map(flag => [`${flag}=data:text/javascript,void 0`]),
    ["--input-type", "module"], ["--input-type=module", "-"],
  ])("keeps code/typed stdin opaque: %j", (...args) => expect(effects(args)).toEqual(["deny", "ask"]));
});
