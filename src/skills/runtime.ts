/**
 * SkillsRuntime — local skill install / enable / invoke lifecycle.
 *
 * Refs:
 * - architecture (local skills runtime)
 * - intelligence-client `registerSkill`
 *
 * A skill is a versioned, integrity-hashed bundle of a system prompt plus
 * optional tool additions and required permissions. The runtime installs from
 * a JSON definition (object or string), enables/disables, pins to a version,
 * auto-selects based on a task string against the skill's `trigger` regex, and
 * invokes a skill to produce the system-prompt fragment + tool additions
 * injected into the chat turn.
 *
 * Built-in first-party skills live in `./builtin.ts`.
 */

import { createHash, randomUUID } from 'node:crypto';

export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  trigger: string;
  systemPrompt: string;
  tools?: string[];
  permissions: string[];
  enabled: boolean;
  pinned: boolean;
  installedAt: string;
  signature?: string;
}

export type SkillSource = string | Omit<LocalSkill, 'installedAt' | 'signature'>;

export interface InvokeResult {
  systemPrompt: string;
  tools?: unknown[];
  result: string;
}

const REQUIRED_FIELDS: ReadonlyArray<keyof LocalSkill> = [
  'id',
  'name',
  'description',
  'version',
  'trigger',
  'systemPrompt',
  'permissions',
];

export class SkillsRuntime {
  private readonly skills = new Map<string, LocalSkill>();

  /** Install a skill from a JSON definition (string or object). */
  async install(source: SkillSource): Promise<LocalSkill> {
    const def = typeof source === 'string' ? (JSON.parse(source) as Record<string, unknown>) : source;
    validateShape(def);

    const now = new Date().toISOString();
    const skill: LocalSkill = {
      id: str(def.id),
      name: str(def.name),
      description: str(def.description),
      version: str(def.version),
      trigger: str(def.trigger),
      systemPrompt: str(def.systemPrompt),
      tools: Array.isArray(def.tools) ? def.tools.map(String) : undefined,
      permissions: Array.isArray(def.permissions) ? def.permissions.map(String) : [],
      enabled: typeof def.enabled === 'boolean' ? def.enabled : true,
      pinned: typeof def.pinned === 'boolean' ? def.pinned : false,
      installedAt: now,
      signature: computeSignature(def),
    };

    this.skills.set(skill.id, skill);
    return skill;
  }

  /** Enable a skill. */
  async enable(skillId: string): Promise<void> {
    const skill = this.skills.get(skillId);
    if (skill) skill.enabled = true;
  }

  /** Disable a skill. */
  async disable(skillId: string): Promise<void> {
    const skill = this.skills.get(skillId);
    if (skill) skill.enabled = false;
  }

  /** Pin a skill to a specific version. */
  async pin(skillId: string, version: string): Promise<void> {
    const skill = this.skills.get(skillId);
    if (!skill) return;
    skill.version = version;
    skill.pinned = true;
    skill.signature = computeSignature(skill as unknown as Record<string, unknown>);
  }

  /** Invoke a skill (returns the system prompt + tool additions). */
  async invoke(skillId: string, input: unknown): Promise<InvokeResult> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      throw new Error(`skill not installed: ${skillId}`);
    }
    if (!skill.enabled) {
      throw new Error(`skill is disabled: ${skillId}`);
    }
    return {
      systemPrompt: skill.systemPrompt,
      tools: skill.tools,
      result: `invoked skill "${skill.id}" (v${skill.version})${input === undefined ? '' : ` with input`}`,
    };
  }

  /** List installed skills. */
  list(): LocalSkill[] {
    return Array.from(this.skills.values());
  }

  /** Auto-select a skill based on the task string (first trigger match). */
  autoSelect(task: string): { skill: LocalSkill; reason: string } | null {
    for (const skill of this.skills.values()) {
      if (!skill.enabled) continue;
      const re = tryCompileRegex(skill.trigger);
      if (!re) continue;
      const match = re.exec(task);
      if (match) {
        return { skill, reason: `trigger "${skill.trigger}" matched "${match[0]}"` };
      }
    }
    return null;
  }

  /** Uninstall a skill. */
  async uninstall(skillId: string): Promise<void> {
    this.skills.delete(skillId);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function validateShape(def: Record<string, unknown>): void {
  for (const field of REQUIRED_FIELDS) {
    const v = def[field];
    if (v === undefined || v === null) {
      throw new Error(`skill definition missing required field: ${String(field)}`);
    }
    if (Array.isArray(v) ? v.length === 0 : String(v).length === 0) {
      throw new Error(`skill field "${String(field)}" is empty`);
    }
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}

function tryCompileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function computeSignature(def: Record<string, unknown>): string {
  const redacted: Record<string, unknown> = { ...def };
  delete redacted.signature;
  delete redacted.installedAt;
  return createHash('sha256').update(JSON.stringify(redacted)).digest('hex').slice(0, 32);
}

/** Ephemeral id generator exposed for tests that synthesize skills inline. */
export function ephemeralSkillId(): string {
  return `skill-${randomUUID()}`;
}
