/**
 * Capix Code — TUI Launch Banner
 *
 * When capix-code starts, the TUI renders the configured app title
 * in the status bar. We patch the TUI entry point to show the Capix banner
 * with brand colors on launch.
 *
 * This is a theme overlay that sets:
 *  - The app title to "Capix Code"
 *  - A launch banner with the Capix logo (ASCII)
 *  - Brand colors
 */

import packageJson from "../package.json" with { type: "json" };

export const VERSION = packageJson.version;

export const CAPIX_BANNER = `
 ██████╗ █████╗ ██████╗ ██╗██╗  ██╗      ██████╗ ██████╗ ██████╗ ███████╗
██╔════╝██╔══██╗██╔══██╗██║╚██╗██╔╝     ██╔════╝██╔═══██╗██╔══██╗██╔════╝
██║     ███████║██████╔╝██║ ╚███╔╝      ██║     ██║   ██║██║  ██║█████╗  
██║     ██╔══██║██╔═══╝ ██║ ██╔██╗     ██║     ██║   ██║██║  ██║██╔══╝  
╚██████╗██║  ██║██║     ██║██╔╝ ██╗    ╚██████╗╚██████╔╝██████╔╝███████╗
 ╚═════╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝

  AI coding agent with smart routing.
  Powered by Capix
`;

export const CAPIX_STATUS = {
  title: "Capix Code",
  version: VERSION,
  brand: "Capix",
  tagline: "AI coding agent with smart routing.",
};

// ANSI color codes matching the brand palette
export const CAPIX_ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // Brand colors
  accent: "\x1b[38;2;61;206;214m",     // #3DCED6 neon teal
  success: "\x1b[38;2;20;241;149m",    // #14F195 green
  text: "\x1b[38;2;241;239;233m",      // #f1efe9 primary text
  muted: "\x1b[38;2;100;116;139m",     // #64748b muted
  secondary: "\x1b[38;2;148;163;184m", // #94a3b8 secondary
  warning: "\x1b[38;2;251;191;36m",   // #fbbf24 amber
};

export function renderBanner(): string {
  const { accent, success, muted, reset, dim } = CAPIX_ANSI;
  const lines = CAPIX_BANNER.split("\n");
  const colored = lines.map(line => `${accent}${line}${reset}`).join("\n");
  const tagline = `  ${success}◆${reset} ${muted}AI coding agent with smart routing.${reset}`;
  const poweredBy = `  ${dim}Powered by Capix${reset}`;
  return `${colored}\n${tagline}\n${poweredBy}`;
}
