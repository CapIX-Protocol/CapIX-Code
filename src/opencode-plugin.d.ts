declare module "@opencode-ai/plugin" {
  export interface PluginContext {
    sessionId?: string;
    model?: string;
  }

  export interface PluginMessage {
    messages?: Array<{ role: string; content: string }>;
    model?: string;
    [key: string]: unknown;
  }

  export interface Plugin {
    name: string;
    onMessage?(message: PluginMessage, context: PluginContext): Promise<PluginMessage>;
    info?(): Record<string, unknown>;
    [key: string]: unknown;
  }
}
