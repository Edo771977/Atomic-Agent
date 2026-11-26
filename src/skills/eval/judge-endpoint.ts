import { classifiableHostOf, isLoopbackUrl } from "../../llm/provider/url-host.js";

/** Readiness only. Reserved credential destinations are checked separately. */
export function requiresJudgeApiKey(baseUrl: string): boolean {
  const host = classifiableHostOf(baseUrl);
  return host !== null && !isLoopbackUrl(baseUrl) && !host.endsWith(".local");
}
