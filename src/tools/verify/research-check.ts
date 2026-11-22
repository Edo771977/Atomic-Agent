import { extractDocument } from "./document-check.js";
import type { ArtifactOutcome } from "./artifact-process.js";

export const MAX_RESEARCH_LINKS = 32;
const MAX_REFERENCES = 128;
export interface ResearchLink {
  readonly url: string;
  readonly citations: string;
  readonly ambiguous?: boolean;
}

export interface ResearchLinkVerdict extends ResearchLink {
  readonly status: "verified" | "missing" | "unverified";
  readonly reason: string;
}

const SOURCE_TITLES = new Set(["fonti", "sources", "references", "bibliography", "bibliografia"]);
const SOURCE_ENTRY = /^\s*(?:[-*+]\s+)?(\[[1-9]\d{0,5}\])(?:\s+|:\s*)(\S.*)$/u;
const NOTE_ENTRY = /^\s*(?:[-*+]\s+)?(\[\^[1-9]\d{0,5}\]):\s*(\S.*)$/u;
const CITATION = /(?<![\\\p{L}\p{N}_])\[\^?[1-9]\d{0,5}\](?![(:])/gu;
const DATE = /(?:\((?:1[5-9]|2[01])\d{2}(?:-\d{2}-\d{2})?\)|(?:^|\s)(?:date|dated|data|published|publication date|accessed)\s*:\s*(?:1[5-9]|2[01])\d{2}(?:-\d{2}-\d{2})?(?=$|[\s.,;]))/iu;

function isSourceTitle(line: string): boolean {
  let title = line.trim().replace(/^#{1,6}\s+/u, "").replace(/(?<!#)#+$/u, "").trimEnd();
  if (title.endsWith(":")) title = title.slice(0, -1).trimEnd();
  if (title.startsWith("**") && title.endsWith("**")) title = title.slice(2, -2).trim();
  if (title.endsWith(":")) title = title.slice(0, -1).trimEnd();
  return SOURCE_TITLES.has(title.toLowerCase());
}

function sourceUrl(token: string, prefix: string) {
  const stack: string[] = [];
  let end = token.length;
  let invalidPair = false;
  for (let i = 0; i < token.length; i += 1) {
    const char = token[i];
    if (char === "(" || char === "[") stack.push(char);
    else if (char === ")" || char === "]") {
      if (!stack.length) { end = i; break; }
      if (stack.pop() !== (char === ")" ? "(" : "[")) invalidPair = true;
    }
  }
  const tail = token.slice(end);
  const bracketed = prefix.endsWith("<") || (prefix.endsWith("](") && tail.startsWith(")"));
  let url = token.slice(0, end);
  const truncated = !bracketed && /(?:\.{3}|…)(?:\*\*|__)?$/u.test(url);
  if (!bracketed && !truncated) {
    url = url.replace(/[.,;!?]+$/u, "");
    if ((prefix.endsWith("**") && url.endsWith("**")) || (prefix.endsWith("__") && url.endsWith("__"))) {
      url = url.slice(0, -2);
    }
  }
  const ambiguous = truncated || invalidPair || stack.length !== 0 ||
    (tail !== "" && !/^[)\]*_.,;!?]+$/u.test(tail)) || /%(?![\da-f]{2})/iu.test(url);
  return { url, ambiguous };
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
    if (isSourceTitle(line)) {
      bibliography = true;
      continue;
    }
    const definition = NOTE_ENTRY.exec(line) ?? (bibliography ? SOURCE_ENTRY.exec(line) : null);
    if (definition !== null) {
      const [, id, text] = definition;
      if (sources.has(id!)) failures.push("duplicate source " + id);
      else sources.set(id!, text!);
    } else if (line.trim() !== "") {
      bibliography = false;
      const prose = line.replace(/\x60+[^\x60]*\x60+|\x60.*$/gu, "");
      if (!/^\s*\[[1-9]\d{0,5}\]:/u.test(prose)) {
        for (const match of prose.matchAll(CITATION)) citations.add(match[0]);
      }
    }
    if (sources.size > MAX_REFERENCES || citations.size > MAX_REFERENCES || failures.length > MAX_REFERENCES) {
      return { status: "uncheckable", detail: `research exceeds the ${MAX_REFERENCES}-reference limit` };
    }
  }
  for (const id of citations) if (!sources.has(id)) failures.push(`citation ${id} has no source`);
  const links = new Map<string, { ids: string[]; ambiguous: boolean }>();
  let linkLimit = false;
  for (const [id, text] of sources) {
    if (!citations.has(id)) warnings.push(`warning: source ${id} is uncited`);
    const urls = /https?:\/\/[^\s<>"'\x60]+/giu;
    if (!DATE.test(text.replace(urls, " "))) {
      (requireDates ? failures : warnings).push(`${requireDates ? "" : "warning: "}source ${id} has no date`);
    }
    for (const match of text.matchAll(urls)) {
      const { url, ambiguous } = sourceUrl(match[0], text.slice(Math.max(0, match.index - 2), match.index));
      if (url.length > 1024 || (links.size >= MAX_RESEARCH_LINKS && !links.has(url))) {
        linkLimit = true;
        continue;
      }
      const link = links.get(url) ?? { ids: [], ambiguous: false };
      if (!link.ids.includes(id)) link.ids.push(id);
      link.ambiguous ||= ambiguous;
      links.set(url, link);
    }
  }
  const detail = [`${citations.size} citation(s), ${sources.size} source(s)`, ...failures, ...warnings].join("\n");
  return {
    status: failures.length ? "fail" : linkLimit || citations.size === 0 || sources.size === 0 ? "uncheckable" : "pass",
    detail: detail + (linkLimit ? `\nlink limit exceeded (${MAX_RESEARCH_LINKS} URLs of up to 1024 characters)` : sources.size === 0 ? "\nno supported sources" : citations.size === 0 ? "\nno supported inline citations" : ""),
    links: [...links].map(([url, { ids, ambiguous }]) => ({ url, citations: ids.join(", "), ...(ambiguous ? { ambiguous } : {}) })),
    ...(linkLimit ? { linkLimit: true } : {}),
  };
}
