export type EngineMode = 'ask' | 'plan' | 'build' | 'debug' | 'review';

export interface ModePermissions {
  canEditFiles: boolean;
  canRunCommands: boolean;
  canCreateFiles: boolean;
  canDeleteFiles: boolean;
  toolAllowlist: string[] | null;
  description: string;
}

const MODE_PERMISSIONS: Record<EngineMode, ModePermissions> = {
  ask: { canEditFiles: false, canRunCommands: false, canCreateFiles: false, canDeleteFiles: false, toolAllowlist: ['read_file', 'capix_search_codebase', 'capix_find_references', 'capix_get_orientation'], description: 'Ask mode: read-only' },
  plan: { canEditFiles: false, canRunCommands: false, canCreateFiles: false, canDeleteFiles: false, toolAllowlist: ['read_file', 'capix_search_codebase', 'capix_find_references', 'capix_get_orientation', 'capix_plan'], description: 'Plan mode: research only' },
  build: { canEditFiles: true, canRunCommands: true, canCreateFiles: true, canDeleteFiles: false, toolAllowlist: null, description: 'Build mode: full implementation' },
  debug: { canEditFiles: true, canRunCommands: true, canCreateFiles: false, canDeleteFiles: false, toolAllowlist: null, description: 'Debug mode: reproduce then repair' },
  review: { canEditFiles: false, canRunCommands: false, canCreateFiles: false, canDeleteFiles: false, toolAllowlist: ['read_file', 'capix_search_codebase', 'capix_find_references', 'capix_get_orientation'], description: 'Review mode: read-only' },
};

export function getModePermissions(mode: EngineMode): ModePermissions {
  return MODE_PERMISSIONS[mode] ?? MODE_PERMISSIONS.ask;
}

export function isActionAllowed(mode: EngineMode, action: 'edit' | 'command' | 'create' | 'delete'): boolean {
  const perms = getModePermissions(mode);
  switch (action) {
    case 'edit': return perms.canEditFiles;
    case 'command': return perms.canRunCommands;
    case 'create': return perms.canCreateFiles;
    case 'delete': return perms.canDeleteFiles;
  }
}

export function isToolAllowed(mode: EngineMode, toolName: string): boolean {
  const perms = getModePermissions(mode);
  if (perms.toolAllowlist === null) return true;
  return perms.toolAllowlist.includes(toolName);
}
