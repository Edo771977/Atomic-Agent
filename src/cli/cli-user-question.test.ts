import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { UserQuestion } from "../approval/user-question.js";
import type { StdinLineQueue } from "./stdin-line-queue.js";
import { cliShowsQuestions, promptCliQuestion } from "./cli-user-question.js";
import { formatCliApprovalPrompt } from "./run-agent.js";

/** `ask_user` in `atomic-agent run` (ATO-489): numbered options or own words. */

const QUESTION: UserQuestion = {
  prompt: "Which database?",
  options: [{ label: "Postgres", description: "the server one" }, { label: "SQLite" }],
  multiSelect: false,
  allowOther: true,
};

function queue(lines: string[]): StdinLineQueue {
  return {
    next: async () => lines.shift() ?? null,
    peek: async () => lines[0] ?? null,
    close: () => {},
  } as unknown as StdinLineQueue;
}

function sink() {
  const out: string[] = [];
  return { out, write: (s: string) => void out.push(s) };
}

describe("ask_user in the CLI", () => {
  it("shows the question with numbered options, not a y/N approval", () => {
    const request = {
      approvalId: "a1",
      sessionId: "s1",
      tool: "ask_user",
      category: "user_question",
      reason: "Which database?",
      question: QUESTION,
    } as unknown as ApprovalRequest;
    const text = formatCliApprovalPrompt(request);
    expect(text).toContain("Which database?");
    expect(text).toContain("1. Postgres - the server one");
    expect(text).toContain("2. SQLite");
    expect(text).not.toContain("approve?");
  });

  it("takes a number as the picked option", async () => {
    const { write } = sink();
    await expect(promptCliQuestion(QUESTION, queue(["2"]), write)).resolves.toEqual({
      approved: true,
      answer: { selected: ["SQLite"] },
    });
  });

  it("takes typed words as the person's own answer", async () => {
    const { write } = sink();
    const result = await promptCliQuestion(QUESTION, queue(["MySQL please"]), write);
    expect(result).toMatchObject({ approved: true, answer: { other: "MySQL please" } });
  });

  it("asks again after an answer the question does not take, then accepts", async () => {
    const { out, write } = sink();
    const result = await promptCliQuestion(QUESTION, queue(["7", "1"]), write);
    expect(result).toEqual({ approved: true, answer: { selected: ["Postgres"] } });
    expect(out.join("")).toContain("pick a number from 1 to 2");
  });

  it("an empty line or end of input skips the question", async () => {
    const { write } = sink();
    await expect(promptCliQuestion(QUESTION, queue([""]), write)).resolves.toEqual({ approved: false });
    await expect(promptCliQuestion(QUESTION, queue([]), write)).resolves.toEqual({ approved: false });
  });

  it("offers ask_user only to an interactive terminal that is not --no-approval", () => {
    expect(cliShowsQuestions({ stdinIsTTY: true, noApproval: false })).toBe(true);
    expect(cliShowsQuestions({ stdinIsTTY: false, noApproval: false })).toBe(false);
    expect(cliShowsQuestions({ stdinIsTTY: true, noApproval: true })).toBe(false);
  });
});
