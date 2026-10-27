// The look of the menus, HUD and dialogs: the browser build's paper style
// sheet, rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start, plus the built-in widgets' looks (checkboxes, selects, text
// fields, dialogs, scroll bars) in the same paper colours. High contrast and
// larger text are the runtime's (it forces the UI's colours and scales its
// text).
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export const PAPER = {
  bg: "#f6ead8", panel: "#fdf8ef", edge: "#e2d2b8", ink: "#3d332a", soft: "#7a6c5c", accent: "#d96f4e", focus: "#2f6fd0", danger: "#b5452e",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 30, padding: 8, spacing: 8, radius: 10,
    text: PAPER.ink, muted: PAPER.soft, panel: PAPER.panel, control: PAPER.panel, hovered: "#fbf0e0",
    pressed: "#f3e4cc", field: "#ffffff", accent: PAPER.accent, focus: PAPER.focus, outline: PAPER.edge,
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$ink" }, minHeight: 40,
      parts: { box: { background: "#ffffff", border: { width: 1, color: "$soft" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$ink" }, background: "#ffffff", border: { width: 1, color: "$edge" }, radius: 8, minHeight: 40 },
    textField: { text: { color: "$ink" }, background: "#ffffff", border: { width: 1, color: "$edge" }, radius: 8, minHeight: 40 },
    dialog: {
      background: "$panel", radius: 18, padding: 24, border: { width: 1, color: "$edge" }, shadow: { y: 6, blur: 24, color: "#50381e24" },
      parts: { backdrop: { background: "#f6ead8d1" } },
    },
    scrollArea: { parts: { bar: { background: "$soft", radius: 4 } } },
    tooltip: { background: "$ink", text: { color: "$panel" }, radius: 6, padding: 6 },
  });
}
