import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { findIntegration } from "../integrations/integration-registry.js";
import { buildStablePrefix, type StablePrefixInput } from "./stable-prefix.js";

it("keeps account mutations and connected-account listing out of the CLI and TUI", () => {
  expect(existsSync(new URL("../cli/composio-command.ts", import.meta.url))).toBe(false);
  expect(existsSync(new URL("../tui/integrations/integrations-orchestrator-composio.ts", import.meta.url))).toBe(false);
  const integration = findIntegration("composio")!;
  expect(integration.fields.map(field => field.key)).not.toEqual(expect.arrayContaining(["addAccount"]));
  for (const field of integration.fields) expect(["addAccount", "defaultAccount", "removeAccount"]).not.toContain(field.key);
  expect(integration.actions?.some(action => action.id === "accounts") ?? false).toBe(false);
});

it("keeps prefix bytes and personal account names independent of account selection on both transports", () => {
  for (const toolTransport of ["grammar", "native_tools"] as const) {
    const input: StablePrefixInput & { composioAccounts?: { toolkit: string; alias: string; isDefault: boolean }[] } = {
      toolDescriptors: [{ name: "mcp.composio.COMPOSIO_SEARCH_TOOLS", summary: "Search", argsSchema: "{}" }],
      capabilities: { platform: "linux", arch: "x64", browserChannel: "none", workingDir: "/fixture", hasClipboard: false, hasWmctrl: false, hasNotifications: false },
      skillCatalog: [], toolTransport,
      composioAccounts: [{ toolkit: "gmail", alias: "b4c-private@example.test", isDefault: true }],
    };
    const before = buildStablePrefix(input);
    input.composioAccounts = [{ toolkit: "gmail", alias: "home", isDefault: true }];
    expect(Buffer.from(buildStablePrefix(input)).equals(Buffer.from(before))).toBe(true);
    expect(before).not.toContain("b4c-private@example.test");
    expect(before).not.toContain("Named Composio accounts:");
  }
});
