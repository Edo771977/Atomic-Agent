import type { HttpCaller } from "./scoped-auth.js";
import { sendJson, type HandlerContext } from "./request-context.js";
import { openaiError } from "./openai-errors.js";
import type { ServerResponse } from "node:http";

/** Owned by one listener; both auxiliary inference routes share these slots. */
export class AuxiliaryCompletions {
  private namedTotal = 0;
  private readonly callers = new Map<string, number>();

  acquire(caller: HttpCaller | undefined): (() => void) | null {
    const key = caller?.role === "owner" ? "owner" : caller ? `token:${caller.name}` : "anonymous";
    const named = caller?.role !== "owner";
    const count = this.callers.get(key) ?? 0;
    if (count >= 2 || (named && this.namedTotal >= 4)) return null;
    this.callers.set(key, count + 1);
    if (named) this.namedTotal += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (named) this.namedTotal -= 1;
      const remaining = (this.callers.get(key) ?? 1) - 1;
      if (remaining === 0) this.callers.delete(key);
      else this.callers.set(key, remaining);
    };
  }
}

export function admitAuxiliaryCompletion(ctx: HandlerContext, res: ServerResponse): (() => void) | null {
  // Hand-built handler contexts can omit the listener-owned admission service.
  const release = ctx.auxiliaryCompletions ? ctx.auxiliaryCompletions.acquire(ctx.caller) : () => {};
  if (release === null) sendJson(res, 429, openaiError("Too many concurrent completion requests; try again later", "server_error", null, "completion_concurrency_limit"), { "retry-after": "1" });
  return release;
}
