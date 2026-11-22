export function lessonProposalHint(source: "correction" | "milestone-failure", milestone: { id: string; runIds: readonly string[] }): string {
  const run = milestone.runIds.at(-1);
  const from = `milestone ${milestone.id}, run ${run ?? "none recorded"}`;
  return `If this evidence supports a reusable lesson, use project.lesson.propose with source: ${source} and from: ${from}.`;
}

export const PROJECT_LESSONS_COMPLETE_HINT =
  "Summarize any reusable candidate lessons from this project. Use project.lesson.propose to save each new proposal with its evidence reference for the person to review.";
