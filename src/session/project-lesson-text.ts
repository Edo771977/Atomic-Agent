/** Unicode formatting, private-use and unassigned characters are not reviewable as lesson text. */
export const PROJECT_LESSON_INVISIBLE_CHARACTERS = /[\p{Cf}\p{Co}\p{Cn}\u2028\u2029\uFFF9-\uFFFB]/gu;

export function projectLessonFingerprint({ hash }: { hash: string }): string {
  return hash.slice(0, 12);
}

export const PROJECT_LESSON_TURN_RUNNING = "A turn is running. Press f afterward.";
