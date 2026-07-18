/**
 * @capix/agent-runtime — agent modes and the permission model.
 *
 * The runtime has five modes. A mode is a permission profile: it decides,
 * for every tool execution, whether the tool is allowed, must be approved
 * by the operator first, or is denied outright.
 *
 * - ask:    read-only Q&A. No writes, no commands, no network.
 * - plan:   research only. Read tools + the planner; no side effects.
 * - build:  full implementation. Writes and commands require approval.
 * - debug:  reproduce-then-repair. Commands pre-approved, edits still asked.
 * - review: read-only review. No writes, no commands.
 *
 * Decisions combine (1) the mode's per-risk-class policy, (2) an optional
 * tool allowlist, and (3) session-scoped grants recorded when the operator
 * answers an approval with "always".
 */

export type AgentMode = 'ask' | 'plan' | 'build' | 'debug' | 'review';

export const AGENT_MODES: readonly AgentMode[] = ['ask', 'plan', 'build', 'debug', 'review'];

export type ToolRiskClass = 'read' | 'write' | 'execute' | 'network' | 'billing';

export type PermissionDecision = 'allow' | 'ask' | 'deny';

export interface ModeProfile {
  mode: AgentMode;
  description: string;
  /** Tools allowed in this mode; `null` means no allowlist restriction. */
  toolAllowlist: string[] | null;
  /** Per-risk-class default decision. */
  riskPermissions: Record<ToolRiskClass, PermissionDecision>;
  canEditFiles: boolean;
  canRunCommands: boolean;
  canCreateFiles: boolean;
  canDeleteFiles: boolean;
  networkAccess: boolean;
}

const READ_TOOLS = [
  'read_file',
  'list_files',
  'capix_search_codebase',
  'capix_find_references',
  'capix_get_orientation',
];

export const MODE_PROFILES: Record<AgentMode, ModeProfile> = {
  ask: {
    mode: 'ask',
    description: 'Ask mode: read-only Q&A',
    toolAllowlist: READ_TOOLS,
    riskPermissions: {
      read: 'allow',
      write: 'deny',
      execute: 'deny',
      network: 'deny',
      billing: 'deny',
    },
    canEditFiles: false,
    canRunCommands: false,
    canCreateFiles: false,
    canDeleteFiles: false,
    networkAccess: false,
  },
  plan: {
    mode: 'plan',
    description: 'Plan mode: research only',
    toolAllowlist: [...READ_TOOLS, 'capix_plan'],
    riskPermissions: {
      read: 'allow',
      write: 'deny',
      execute: 'deny',
      network: 'deny',
      billing: 'deny',
    },
    canEditFiles: false,
    canRunCommands: false,
    canCreateFiles: false,
    canDeleteFiles: false,
    networkAccess: false,
  },
  build: {
    mode: 'build',
    description: 'Build mode: full implementation',
    toolAllowlist: null,
    riskPermissions: {
      read: 'allow',
      write: 'ask',
      execute: 'ask',
      network: 'deny',
      billing: 'ask',
    },
    canEditFiles: true,
    canRunCommands: true,
    canCreateFiles: true,
    canDeleteFiles: false,
    networkAccess: false,
  },
  debug: {
    mode: 'debug',
    description: 'Debug mode: reproduce then repair',
    toolAllowlist: null,
    riskPermissions: {
      read: 'allow',
      write: 'ask',
      execute: 'allow',
      network: 'deny',
      billing: 'ask',
    },
    canEditFiles: true,
    canRunCommands: true,
    canCreateFiles: false,
    canDeleteFiles: false,
    networkAccess: false,
  },
  review: {
    mode: 'review',
    description: 'Review mode: read-only',
    toolAllowlist: READ_TOOLS,
    riskPermissions: {
      read: 'allow',
      write: 'deny',
      execute: 'deny',
      network: 'deny',
      billing: 'deny',
    },
    canEditFiles: false,
    canRunCommands: false,
    canCreateFiles: false,
    canDeleteFiles: false,
    networkAccess: false,
  },
};

export function isAgentMode(value: string): value is AgentMode {
  return (AGENT_MODES as readonly string[]).includes(value);
}

export function getModeProfile(mode: AgentMode): ModeProfile {
  return MODE_PROFILES[mode] ?? MODE_PROFILES.ask;
}

export interface PermissionCheck {
  decision: PermissionDecision;
  reason: string;
}

/**
 * Decide whether `toolName` (with risk class `riskClass`) may run under
 * `mode`, given session-scoped grants. Grants keyed by tool name override
 * the mode's per-risk-class default; the allowlist always wins over grants
 * for tools outside it (a grant can never promote a tool the mode forbids).
 */
export function checkModePermission(
  mode: AgentMode,
  toolName: string,
  riskClass: ToolRiskClass,
  grants?: ReadonlyMap<string, PermissionDecision>
): PermissionCheck {
  const profile = getModeProfile(mode);

  if (profile.toolAllowlist !== null && !profile.toolAllowlist.includes(toolName)) {
    return {
      decision: 'deny',
      reason: `tool "${toolName}" is not available in ${mode} mode`,
    };
  }

  const granted = grants?.get(toolName) ?? grants?.get(`${toolName}:${riskClass}`);
  if (granted === 'allow') {
    return { decision: 'allow', reason: `tool "${toolName}" was granted for this session` };
  }
  if (granted === 'deny') {
    return { decision: 'deny', reason: `tool "${toolName}" was denied for this session` };
  }

  const decision = profile.riskPermissions[riskClass];
  return {
    decision,
    reason:
      decision === 'allow'
        ? `${mode} mode allows ${riskClass} tools`
        : decision === 'ask'
          ? `${mode} mode requires approval for ${riskClass} tools`
          : `${mode} mode denies ${riskClass} tools`,
  };
}
