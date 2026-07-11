/**
 * Capix Smart Route Plugin for capix-code.
 *
 * Three routing modes:
 *
 * 1. AUTO (default) — uses long-term memory to pick the best model from the
 *    live OpenRouter + Surplus catalog for each task (reasoning vs coding).
 *    Learns from user overrides and adjusts future routing.
 *
 * 2. PRIVATE — uses the user's deployed private LLM (via the Capix MCP
 *    server). If none exists, signals the MCP server to deploy one (an
 *    uncensored Jiunsong model), then uses it. When the session ends,
 *    the LLM is destroyed.
 *
 * 3. LOOP — same as PRIVATE, but the agent keeps building until the task
 *    is complete, then destroys the LLM automatically.
 *
 * The router is born with memory — it loads its learned state from
 * ~/.config/capix-code/smart-router-memory.json on every spawn, so it
 * already knows what it learned in previous sessions.
 *
 * Set the mode via CAPIX_ROUTE_MODE=auto|private|loop (default: auto).
 */

import type { Plugin } from "@opencode-ai/plugin";
import { SmartRouter, type RouteMode } from "./smartRouter";

// Singleton router — persists memory across the session.
let router: SmartRouter | null = null;

function getRouter(): SmartRouter {
  if (!router) router = new SmartRouter();
  return router;
}

function getMode(): RouteMode {
  const env = (process.env.CAPIX_ROUTE_MODE || "auto").toLowerCase();
  if (env === "private") return "private";
  if (env === "loop") return "loop";
  return "auto";
}

export const capixSmartRoute: Plugin = {
  name: "capix-smart-route",

  async onMessage(message, context) {
    const r = getRouter();
    const mode = getMode();
    const baseUrl = process.env.CAPIX_BASE_URL || "https://capix.network/api/v1";
    // TODO(security): API key is read from an env var. The upstream runtime
    // stores credentials in plaintext JSON. Auth should use the OS keychain
    // (macOS Keychain, Windows Credential Manager, Linux Secret Service)
    // instead — tracked as a separate larger task.
    const apiKey = process.env.CAPIX_API_KEY || "";
    const sessionId = context.sessionId;

    if (!apiKey) {
      // No API key — fall back to a coding model.
      return { ...message, model: "capix/supergemma-gemma3-4b" };
    }

    // ── AUTO mode: dynamic smart routing ──────────────────────────────────
    if (mode === "auto" || (mode !== "private" && mode !== "loop")) {
      // Only intercept when the user is on `capix/auto`.
      if (context.model !== "capix/auto" && context.model !== "auto") {
        return message;
      }

      const lastUserMsg = message.messages
        ?.filter((m: { role: string }) => m.role === "user")
        ?.pop()?.content;

      if (!lastUserMsg || typeof lastUserMsg !== "string") {
        return { ...message, model: "capix/supergemma-gemma3-4b" };
      }

      const route = await r.routeAuto(lastUserMsg, sessionId, baseUrl, apiKey);
      return { ...message, model: route.model };
    }

    // ── PRIVATE / LOOP mode: use deployed LLM or signal deploy ───────────
    const route = mode === "loop" ? r.routeLoop() : r.routePrivate();

    if (route.model === "__NEEDS_DEPLOY__") {
      // No private endpoint — signal the MCP server to deploy one.
      // The MCP server's capix_deploy_and_wait tool will handle this.
      // For now, fall back to auto routing until the deploy completes.
      const lastUserMsg = message.messages
        ?.filter((m: { role: string }) => m.role === "user")
        ?.pop()?.content || "";

      const autoRoute = await r.routeAuto(lastUserMsg, sessionId, baseUrl, apiKey);

      // Return a special instruction for the agent to deploy a private LLM.
      return {
        ...message,
        model: autoRoute.model,
        _capixDeployPrivate: true, // signal to the MCP integration
      };
    }

    if (route.privateEndpoint) {
      // Use the private endpoint directly — rewrite the base URL + API key.
      return {
        ...message,
        model: route.privateEndpoint.modelLabel,
        _capixPrivateEndpoint: {
          baseUrl: route.privateEndpoint.baseUrl,
          apiKey: route.privateEndpoint.apiKey,
        },
      };
    }

    return message;
  },

  // Expose router memory for the TUI status display.
  info() {
    const r = getRouter();
    return {
      mode: getMode(),
      memory: r.getMemorySummary(),
      hasPrivateEndpoint: r.hasPrivateEndpoint(),
    };
  },
};

// ── Export the router for external use (MCP integration, TUI display) ─────

export { getRouter as getSmartRouter };
export { SmartRouter };
export type { RouteMode, RouteResult };
