import type { ResolvedModelMode } from "../../llm/model-mode.js";

export type SideCallProvider = Pick<ResolvedModelMode, "providerId" | "mode">;

export function sameSideCallProvider(turn: SideCallProvider, active: SideCallProvider): boolean {
  return turn.providerId === active.providerId && !(turn.mode === "local" && active.mode === "cloud");
}
