/**
 * Whether a check's failure text says the check never actually ran: held,
 * refused, timed out, cancelled, not wired, or its binary missing. Such a
 * failure is no finding about the work (issue #100 review).
 */
export function checkDidNotRun(text: string): boolean {
  return /did not run|not run|held|timed out|time limit|refused|denied|not allowed|cancel|not wired|no result|command not found|ENOENT|EACCES/i.test(text);
}
