import { homedir } from "node:os";
import { parse, relative, resolve } from "node:path";

const DEVICE_PREFIX = /^[\\/]{2}[?.](?:[\\/]|$)/;
const RESERVED_COMPONENT = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

function unsupportedComponent(part: string): boolean {
  return part === "." || part === ".." || /[. ]$/.test(part) ||
    /[<>:"|?*\u0000-\u001f]/.test(part) || RESERVED_COMPONENT.test(part);
}

/**
 * A spelling comparable with ordinary native scope paths, or no safe
 * comparison. Extended drive/UNC paths identify the same files only when
 * removing their prefix does not invoke Win32's different normalization
 * of dot segments, trailing dots/spaces or reserved device components.
 * Device namespaces and other extended forms are refused, not guessed.
 * This is lexical scope handling; it does not resolve symbolic links.
 */
export function comparableScopePath(path: string): string | null {
  if (process.platform !== "win32") return path;
  if (!DEVICE_PREFIX.test(path)) {
    // Ordinary Win32 trailing-dot/space aliases also cannot safely serve
    // as an independent grant beside the canonical home/project path.
    const parts = resolve(path).replace(/^[A-Za-z]:\\/, "").split("\\").filter(Boolean);
    return parts.some(unsupportedComponent) ? null : path;
  }
  if (!path.startsWith("\\\\?\\") || path.includes("/")) return null;
  const tail = path.slice(4);
  let ordinary: string;
  let parts: string[];
  if (/^[A-Za-z]:\\/.test(tail)) {
    ordinary = tail;
    parts = tail.slice(3).split("\\");
  } else if (/^UNC\\/i.test(tail)) {
    parts = tail.slice(4).split("\\");
    if (!parts[0] || !parts[1]) return null;
    ordinary = `\\\\${tail.slice(4)}`;
  } else {
    return null;
  }
  if (parts.some((part, i) => part === "" ? i !== parts.length - 1 : unsupportedComponent(part))) return null;
  return ordinary;
}

/**
 * A drive or filesystem root, the home folder or its parent: too broad to
 * hand to a fan-out as a write scope, to run a project in, or to copy for
 * a verification. Native path equality also covers Windows drive/UNC
 * roots, separator aliases and case differences. A path with no safe
 * comparison counts as too broad.
 */
export function isTooBroadScope(dir: string, home: string = homedir()): boolean {
  const comparableHome = comparableScopePath(home);
  const comparable = comparableScopePath(dir);
  if (comparableHome === null || comparable === null) return true;
  const absolute = resolve(comparable);
  return [parse(absolute).root, comparableHome, resolve(comparableHome, "..")].some(
    (broad) => relative(broad, absolute) === "",
  );
}

/**
 * Why work that needs a project folder did not start in `dir`, and what
 * the person does about it on each surface.
 */
export function tooBroadWorkdirMessage(dir: string, what: string): string {
  return `${what} needs a project folder, and this session's folder ${dir} is too broad ` +
    "(a drive or filesystem root, the home folder or its parent). Choose or create a project folder for it: " +
    "in the desktop app with the workspace chip, in the TUI or CLI by starting from that folder (cd into it) or with --cwd.";
}
