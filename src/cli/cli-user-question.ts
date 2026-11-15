import {
  parseTypedUserQuestionAnswer,
  renderUserQuestionText,
  type UserQuestion,
  type UserQuestionAnswer,
} from "../approval/user-question.js";
import type { StdinLineQueue } from "./stdin-line-queue.js";

/**
 * `ask_user` in `atomic-agent run` (ATO-489). The question is printed
 * with numbered options and the next stdin line is the answer: a
 * number, several (`1,3` when the question takes more than one), or the
 * person's own words when it allows them (`parseTypedUserQuestionAnswer`,
 * the same reading the TUI composer uses). An empty line or the end of
 * input skips the question, which the model reads as "go on with your
 * best guess".
 */
export type CliQuestionAnswer =
  | { approved: false }
  | { approved: true; answer: UserQuestionAnswer };

/** Answers that do not fit are asked again this many times, then skipped. */
const MAX_TRIES = 3;

/** The question as the CLI prints it before reading the answer. */
export function formatCliQuestionPrompt(question: UserQuestion): string {
  const body = renderUserQuestionText(question)
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return [
    "",
    `» question: ${question.prompt}`,
    body,
    "  answer (number, your own words, or Enter to skip): ",
  ].join("\n");
}

/**
 * Read the answer to `question` from `lines`. Unlike a y/N approval,
 * any line is taken as the answer: the tool is offered only to an
 * interactive terminal (`cliShowsQuestions`), where the person typing
 * is the one being asked.
 */
export async function promptCliQuestion(
  question: UserQuestion,
  lines: StdinLineQueue,
  write: (text: string) => void,
): Promise<CliQuestionAnswer> {
  for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
    const line = await lines.next();
    if (line === null || line.trim() === "") {
      write("\n  skipped\n");
      return { approved: false };
    }
    const answer = parseTypedUserQuestionAnswer(question, line);
    if (typeof answer !== "string") return { approved: true, answer };
    write(`\n  not an answer to the question: ${answer}\n  answer: `);
  }
  write("\n  skipped\n");
  return { approved: false };
}

/**
 * Whether `run` offers `ask_user`. A piped stdin is a script or an eval
 * driver: the next line is its next message, and a question would eat
 * it as the answer. `--no-approval` asks for an unattended run, where a
 * question would park the turn. Both get the tool hidden (the runtime
 * then answers a stray call at once, `ask-user.ts`).
 */
export function cliShowsQuestions(input: { stdinIsTTY: boolean; noApproval: boolean }): boolean {
  return input.stdinIsTTY && !input.noApproval;
}
