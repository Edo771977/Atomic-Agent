import { SIDE_QUESTION_SESSION_PREFIX } from "../runtime/side-question.js";
import { EXPERIENCE_REVIEW_SESSION_PREFIX } from "../runtime/composition/runtime-experience-review.js";
import { PROMPT_ENHANCE_SESSION_PREFIX } from "../runtime/prompt-enhancer.js";
import { SESSION_TITLE_SESSION_PREFIX } from "../session/session-title.js";
import { NEXT_STEP_SESSION_PREFIX } from "../session/session-next-step.js";
import { EXTRACT_SESSION_PREFIX } from "../tools/browser/extract-request.js";
import { RISK_REVIEW_SESSION_PREFIX } from "../approval/risk-review.js";
import { GOAL_JUDGE_SESSION_PREFIX } from "../agent/goal/goal-judge.js";
import { COMPACTION_SESSION_PREFIX } from "../runtime/context-compaction-model.js";
import { REWRITER_SESSION_PREFIX } from "../memory/retrieve/query-rewriter-runner.js";
import { LINK_GENERATOR_SESSION_PREFIX } from "../memory/links/link-generator-runner.js";
import { VOTE_SESSION_PREFIX } from "../memory/voting/vote-runner.js";
import { NOTE_RECONCILE_SESSION_PREFIX } from "../memory/reconcile/note-reconcile-runner.js";
import { REFLECTION_SESSION_PREFIX } from "../memory/reflection/reflection-runner.js";
import { GRAMMAR_SMOKE_SESSION_PREFIX } from "../llm/grammar/grammar-smoke.js";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** Imported from the production callers, independently of the registry list. */
export const AUXILIARY_CALLERS = [
  ["SIDE_QUESTION_SESSION_PREFIX", SIDE_QUESTION_SESSION_PREFIX], ["EXPERIENCE_REVIEW_SESSION_PREFIX", EXPERIENCE_REVIEW_SESSION_PREFIX],
  ["PROMPT_ENHANCE_SESSION_PREFIX", PROMPT_ENHANCE_SESSION_PREFIX], ["SESSION_TITLE_SESSION_PREFIX", SESSION_TITLE_SESSION_PREFIX],
  ["NEXT_STEP_SESSION_PREFIX", NEXT_STEP_SESSION_PREFIX], ["EXTRACT_SESSION_PREFIX", EXTRACT_SESSION_PREFIX],
  ["RISK_REVIEW_SESSION_PREFIX", RISK_REVIEW_SESSION_PREFIX], ["GOAL_JUDGE_SESSION_PREFIX", GOAL_JUDGE_SESSION_PREFIX],
  ["COMPACTION_SESSION_PREFIX", COMPACTION_SESSION_PREFIX], ["REWRITER_SESSION_PREFIX", REWRITER_SESSION_PREFIX],
  ["LINK_GENERATOR_SESSION_PREFIX", LINK_GENERATOR_SESSION_PREFIX], ["VOTE_SESSION_PREFIX", VOTE_SESSION_PREFIX],
  ["NOTE_RECONCILE_SESSION_PREFIX", NOTE_RECONCILE_SESSION_PREFIX], ["REFLECTION_SESSION_PREFIX", REFLECTION_SESSION_PREFIX],
] as const;

export const CALLER_PARTITIONS = AUXILIARY_CALLERS.map(([, prefix]) => prefix.slice(0, -1));

interface ExportedSessionPrefix { source: string; name: string; prefix: string }

export const SESSION_PREFIX_EXCLUSIONS: Readonly<Record<string, { source: string; prefix: string; reason: string }>> = {
  GRAMMAR_SMOKE_SESSION_PREFIX: {
    source: "llm/grammar/grammar-smoke.ts", prefix: GRAMMAR_SMOKE_SESSION_PREFIX,
    reason: "Synthetic grammar-protocol probe partitioned by provider, with no chat owner.",
  },
};

/** Discover exported constants from production source, independently of the manual imports. */
export function scanExportedSessionPrefixes(root = fileURLToPath(new URL("../", import.meta.url))): ExportedSessionPrefix[] {
  const found: ExportedSessionPrefix[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.(test|d)\.tsx?$/.test(entry.name) || entry.name.endsWith("-test-helpers.ts")) continue;
      const source = relative(root, path).split(sep).join("/");
      const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false);
      for (const statement of ast.statements) {
        if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)
          || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith("_SESSION_PREFIX")) continue;
          let value = declaration.initializer;
          while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
          if (!value || !ts.isStringLiteralLike(value)) throw new Error(`${source}: ${declaration.name.text} needs an explicit literal prefix for discovery`);
          found.push({ source, name: declaration.name.text, prefix: value.text });
        }
      }
    }
  };
  visit(root);
  return found;
}

export function sessionPrefixCoverageErrors(discovered: readonly ExportedSessionPrefix[]): string[] {
  const registered = new Map<string, string>(AUXILIARY_CALLERS);
  const errors: string[] = [];
  for (const entry of discovered) {
    const exclusion = SESSION_PREFIX_EXCLUSIONS[entry.name];
    if (exclusion) {
      if (exclusion.source !== entry.source || exclusion.prefix !== entry.prefix || !exclusion.reason) errors.push(`Invalid exclusion for ${entry.source}: ${entry.name}`);
    } else if (registered.get(entry.name) !== entry.prefix) {
      errors.push(`Unregistered caller ${entry.source}: ${entry.name} (${entry.prefix})`);
    }
  }
  return errors;
}
