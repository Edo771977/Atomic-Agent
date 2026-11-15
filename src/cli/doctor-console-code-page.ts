import type { DoctorContext, DoctorFinding } from "./doctor-checks.js";
import { readConsoleCodePage, UTF8_CODE_PAGE } from "./windows-console-utf8.js";

const TRACE_HINT =
  "traces and logs are UTF-8 without a BOM: in Windows PowerShell 5.1 read them with Get-Content -Encoding UTF8 <file>, " +
  "or accented text looks garbled although the file is fine";

/**
 * Windows only: the console code page this run sees. Startup switches an
 * interactive console to UTF-8 (`ensureUtf8Console`), so a page other than
 * 65001 here means the switch did not take. It matters for the output of
 * console programs the agent runs; typed TUI input is read from the console
 * as UTF-16 and does not depend on it.
 */
export function checkConsoleCodePage(
  ctx: Pick<DoctorContext, "platform" | "consoleCodePage">,
): DoctorFinding[] {
  if (ctx.platform !== "win32") return [];
  const page = (ctx.consoleCodePage ?? readConsoleCodePage)();
  if (page === undefined) {
    return [{ check: "console-code-page", status: "ok", message: `no console code page to read (no console attached); ${TRACE_HINT}` }];
  }
  if (page === UTF8_CODE_PAGE) {
    return [{ check: "console-code-page", status: "ok", message: `console code page 65001 (UTF-8); ${TRACE_HINT}` }];
  }
  return [{
    check: "console-code-page",
    status: "warn",
    message:
      `console code page ${page}, not UTF-8: non-ASCII output of console programs the agent runs may be garbled; ` +
      `run chcp 65001 before starting. TUI typed input is not affected (it is read as UTF-16); ${TRACE_HINT}`,
  }];
}
