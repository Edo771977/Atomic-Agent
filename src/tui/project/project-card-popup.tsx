import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { useMouseTarget } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { chromeTheme } from "../theme/theme.js";
import { fitToWidth } from "../components/fit-to-width.js";
import type { ProjectCardState } from "./project-card-state.js";
import { wrapOsc8 } from "../render/osc8-link.js";
import { projectCardLines, type ProjectLineTone } from "./project-card-lines.js";

export interface ProjectCardPopupProps {
  card: ProjectCardState;
  availableRows: number;
  availableColumns: number;
}

const MAX_WIDTH = 96;

function toneColor(tone: ProjectLineTone | undefined): string | undefined {
  const c = chromeTheme.colors;
  switch (tone) {
    case "title":
      return c.railForeground;
    case "muted":
      return c.railMuted;
    case "warn":
      return c.railWarn;
    case "error":
      return c.railError;
    case "ok":
      return c.railSuccess;
    default:
      return undefined;
  }
}

/** The link covers the text, not the padding that fills the line. */
function linked(text: string, url: string): string {
  const body = text.trimEnd();
  return `${wrapOsc8(body, url)}${text.slice(body.length)}`;
}

/**
 * The fusion project card (issue #39): the brief, plan or milestone
 * waiting on the person, drawn like the other centred popups (absolute
 * inside the content pane, every line padded so the chat cannot show
 * through). The body scrolls (PgUp/PgDn) when taller than the pane; the
 * buttons stay on the last lines.
 */
export function ProjectCardPopup({ card, availableRows, availableColumns }: ProjectCardPopupProps): ReactElement {
  const width = Math.max(40, Math.min(MAX_WIDTH, availableColumns - 2));
  const inner = width - 2;
  const lines = projectCardLines(card, inner);
  const room = Math.max(3, availableRows - 2);
  // The last two lines (buttons/hint, or the mode's prompt) always show.
  const footer = Math.min(card.mode === "note" ? 3 : 2, lines.length);
  const body = lines.slice(0, lines.length - footer);
  const bodyRoom = Math.max(1, room - footer);
  const top = Math.min(card.scroll, Math.max(0, body.length - bodyRoom));
  const visible = [...body.slice(top, top + bodyRoom), ...lines.slice(lines.length - footer)];
  const height = visible.length + 2;
  const ref = useMouseTarget((hit) => isPrimaryPress(hit.event), { layer: MOUSE_LAYER_MODAL });
  return (
    <Box
      ref={ref}
      position="absolute"
      marginTop={Math.max(0, Math.floor((availableRows - height) / 2))}
      marginLeft={Math.max(0, Math.floor((availableColumns - width) / 2))}
      borderStyle="double"
      borderColor={chromeTheme.colors.railAccent}
      backgroundColor={chromeTheme.colors.railBackground}
      width={width}
      flexDirection="column"
    >
      {visible.map((l, idx) => {
        let used = 0;
        return (
          <Text key={idx}>
            {l.segments.map((s, j) => {
              const room = Math.max(0, inner - used);
              const last = j === l.segments.length - 1;
              const t = last ? fitToWidth(s.text, room) : s.text.slice(0, room);
              used += t.length;
              return (
                <Text key={j} color={toneColor(s.tone)} bold={s.bold} inverse={s.inverse}>
                  {s.link === undefined ? t : linked(t, s.link)}
                </Text>
              );
            })}
          </Text>
        );
      })}
    </Box>
  );
}
