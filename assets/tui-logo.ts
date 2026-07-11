// Capix-owned terminal identity. The cell markers are interpreted by the TUI
// renderer: `_` full block, `^` mixed half block and `~` upper half block.
export const logo = {
  left: ["                   ", "█▀▀█ █▀▀█ █▀▀█ █_█ ", "█___ █_^█ █^^_ █_█ ", "▀▀▀▀ ▀~~▀ ▀  ▀ ▀▀▀ "],
  right: ["                   ", "  █ █▀▀▄ █▀▀▀       ", "  █ █__█ █^^        ", "  ▀ ▀  ▀ ▀▀▀▀       "],
}

export const go = {
  left: ["    ", "█▀▀█", "█___", "▀▀▀▀"],
  right: ["    ", "█_█ ", "█_^ ", "▀ ▀ "],
}

export const marks = "_^~,"
