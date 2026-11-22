import { extractDocument } from "./document-check.js";
import type { ArtifactOutcome } from "./artifact-process.js";

export const MAX_RESEARCH_LINKS = 32;
const MAX_REFERENCES = 128;
export interface ResearchLink {
  readonly url: string;
  readonly citations: string;
}

export interface ResearchLinkVerdict extends ResearchLink {
  readonly status: "verified" | "missing" | "unverified";
  readonly reason: string;
}

export async function evaluateResearch(bytes: Buffer, extension: string, requireDates: boolean): Promise<ArtifactOutcome> {
  const doc = await extractDocument(bytes, extension, true);
  if ("status" in doc) return doc;
  const citations = new Set<string>();
  const sources = new Map<string, string>();
  const failures: string[] = [];
  const warnings: string[] = [];
  let bibliography = false;
  let fence: string | undefined;
  for (const line of doc.text.split(/\r\n?|\n/u)) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1]?.[0];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (fence === marker) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    if (/^\s*(?:#{1,6}\s+)?(?:fonti|sources)\s*:?(?:\s+#+)?\s*$/iu.test(line)) {
      bibliography = true;
      continue;
    }
    if (/^\s*#{1,6}\s+/u.test(line)) bibliography = false;
    const definition = /^\s*(?:[-*+]\s+)?(\[\^[1-9]\d{0,5}\]):\s*(\S.*)$/u.exec(line)
      ?? (bibliography ? /^\s*(?:[-*+]\s+)?(\[[1-9]\d{0,5}\])(?:\s+|:\s*)(\S.*)$/u.exec(line) : null);
    if (definition !== null) {
      const [, id, text] = definition;
      if (sources.has(id!)) failures.push(`duplicate source ${id}`);
      else sources.set(id!, text!);
    } else if (!bibliography) {
      for (const match of line.matchAll(/(?<!\\)\[\^?[1-9]\d{0,5}\](?!\()/gu)) citations.add(match[0]);
    }
    if (sources.size > MAX_REFERENCES || citations.size > MAX_REFERENCES || failures.length > MAX_REFERENCES) {
      return { status: "uncheckable", detail: `research exceeds the ${MAX_REFERENCES}-reference limit` };
    }
  }
  for (const id of citations) if (!sources.has(id)) failures.push(`citation ${id} has no source`);
  const links = new Map<string, string[]>();
  let linkLimit = false;
  for (const [id, text] of sources) {
    if (!citations.has(id)) warnings.push(`warning: source ${id} is uncited`);
    const urls = /https?:\/\/[^\s<>"'()[\]]+/giu;
    if (!/\b(?:1[5-9]\d{2}|20\d{2}|21\d{2})\b/u.test(text.replace(urls, ""))) {
      (requireDates ? failures : warnings).push(`${requireDates ? "" : "warning: "}source ${id} has no date`);
    }
    for (const match of text.matchAll(urls)) {
      const url = match[0].replace(/[.,;!?]+$/u, "");
      if (url.length > 1024 || (links.size >= MAX_RESEARCH_LINKS && !links.has(url))) {
        linkLimit = true;
        continue;
      }
      const ids = links.get(url) ?? [];
      if (!ids.includes(id)) ids.push(id);
      links.set(url, ids);
    }
  }
  const detail = [`${citations.size} citation(s), ${sources.size} source(s)`, ...failures, ...warnings].join("\n");
  return {
    status: failures.length ? "fail" : linkLimit || sources.size === 0 ? "uncheckable" : "pass",
    detail: detail + (linkLimit ? `\nlink limit exceeded (${MAX_RESEARCH_LINKS} URLs of up to 1024 characters)` : sources.size === 0 ? "\nno supported sources" : ""),
    links: [...links].map(([url, ids]) => ({ url, citations: ids.join(", ") })),
    ...(linkLimit ? { linkLimit: true } : {}),
  };
}
