import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps ACP outside the executable CLI command registry", () => {
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let commandNames: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "COMMANDS") {
      expect(node.initializer && ts.isArrayLiteralExpression(node.initializer)).toBe(true);
      const commands = node.initializer as ts.ArrayLiteralExpression;
      commandNames = commands.elements.map(element => {
        expect(ts.isObjectLiteralExpression(element)).toBe(true);
        const name = (element as ts.ObjectLiteralExpression).properties.find(property => property.name?.getText(source) === "name") as ts.PropertyAssignment;
        expect(ts.isStringLiteral(name.initializer)).toBe(true);
        return (name.initializer as ts.StringLiteral).text;
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(commandNames).toContain("serve");
  expect(commandNames).toContain("mcp-server");
  expect(commandNames).not.toContain("acp");
});

it("ships no ACP command or stdio server before trusted approval correlation exists", () => {
  for (const file of ["acp-command.ts", "acp-server.ts", "acp-jsonrpc.ts", "acp-translator.ts"]) {
    expect(existsSync(fileURLToPath(new URL(file, import.meta.url))), file).toBe(false);
  }
});
