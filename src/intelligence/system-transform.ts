/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * System prompt transform hook for intelligence injection.
 * Uses the supported experimental.chat.system.transform hook.
 */

interface ContextBlock {
  source: string;
  timestamp: string;
  tokenBudget: number;
  content: string;
}

export function createSystemTransform() {
  return async (systemPrompt: string, _userMessage: string, _sessionId: string): Promise<string> => {
    const blocks: ContextBlock[] = [];
    const now = new Date().toISOString();

    // Orientation (from global cache)
    try {
      const orientation = (globalThis as any).capixOrientation;
      if (orientation) blocks.push({ source: 'codebase-indexer', timestamp: now, tokenBudget: 500, content: `## Workspace\n${orientation}` });
    } catch { /* ignore */ }

    // Retrieved context (from global cache)
    try {
      const context = (globalThis as any).capixRetrievedContext;
      if (context) blocks.push({ source: 'context-retriever', timestamp: now, tokenBudget: 1500, content: `## Relevant Files\n${context}` });
    } catch { /* ignore */ }

    // Memory (from global cache)
    try {
      const memory = (globalThis as any).capixMemoryCache;
      if (memory?.length > 0) blocks.push({ source: 'intelligence-api', timestamp: now, tokenBudget: 500, content: `## Project Memory\n${memory.slice(-5).map((m: any) => `- [${m.type}] ${m.content}`).join('\n')}` });
    } catch { /* ignore */ }

    // Skill (from global cache)
    try {
      const skill = (globalThis as any).capixSelectedSkill;
      if (skill) blocks.push({ source: 'skills-runtime', timestamp: now, tokenBudget: 800, content: `## Active Skill: ${skill.name}\n${skill.systemPrompt}` });
    } catch { /* ignore */ }

    // Escape untrusted content
    const escaped = blocks.map(b => b.content
      .replace(/\[SYSTEM\]/gi, '[CONTEXT]')
      .replace(/\[COVENANT\]/gi, '[CONTEXT]')
    );

    if (escaped.length > 0) {
      return `${systemPrompt}\n\n---\n## Capix Intelligence Context\n\n${escaped.join('\n\n')}`;
    }
    return systemPrompt;
  };
}
