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

/** Whether some descendant can match; null is an exhausted comparison budget. */
export function globMayMatchDescendant(pattern: string, directory: string): boolean | null {
  const prefix = directory.replace(/\/$/, "") + "/";
  return globMayMatchPrefix(pattern, prefix);
}

/** Whether some completion of a known prefix can match the pattern. */
export function globMayMatchPrefix(pattern: string, prefix: string): boolean | null {
  if (prefix.length > MAX_POLICY_RESOURCE_LENGTH || pattern.length > MAX_PATTERN_LENGTH) return null;
  let steps = 0;
  const closure = (states: Set<number>) => {
    for (const i of states) if (pattern[i] === "*") states.add(i + 1);
    return states;
  };
  let states = closure(new Set([0]));
  for (const char of prefix) {
    const next = new Set<number>();
    for (const i of states) {
      if (++steps > MAX_MATCH_STEPS) return null;
      if (pattern[i] === "*") next.add(i);
      else if (pattern[i] === "?" || pattern[i] === char) next.add(i + 1);
    }
    states = closure(next);
    if (states.size === 0) return false;
  }
  return states.size > 0;
}
