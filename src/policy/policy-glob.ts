/** Whole-string wildcards: * includes separators, ? is one UTF-16 code unit. */
export const MAX_POLICY_RESOURCE_LENGTH = 128 * 1024;
const MAX_PATTERN_LENGTH = 4096;
const MAX_MATCH_STEPS = 1_000_000;

/** null means the bounded matcher cannot decide; never use that as an allow. */
export function matchPolicyGlob(pattern: string, value: string): boolean | null {
  if (value.length > MAX_POLICY_RESOURCE_LENGTH || pattern.length > MAX_PATTERN_LENGTH) return null;
  let p = 0, v = 0, star = -1, retry = 0, steps = 0;
  while (v < value.length) {
    if (++steps > MAX_MATCH_STEPS) return null;
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) { p++; v++; }
    else if (pattern[p] === "*") { star = p++; retry = v; }
    else if (star !== -1) { p = star + 1; v = ++retry; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

export function globMatches(pattern: string, value: string): boolean {
  return matchPolicyGlob(pattern, value) === true;
}
