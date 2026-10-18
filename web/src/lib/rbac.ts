// Client mirror of the server's RBAC matrices (server/src/authz/policy.ts).
// The server is authoritative — it re-normalizes and enforces every rule; this
// copy only lets the table show locks and apply dependencies as you click.

export type EditScope = 'none' | 'own' | 'all';
export interface ProjectRolePermissions {
  create: boolean; edit: EditScope; archive: boolean; delete: boolean; pin: boolean;
  restrict: boolean; categories: boolean; onboarding: boolean; audit: boolean;
}
export type ProjectPermissions = Record<'maintainer' | 'member' | 'viewer', ProjectRolePermissions>;

export const TENANT_CAPS = ['settings.view', 'settings.edit', 'members.manage', 'audit.view', 'workspace.create', 'workspace.edit', 'project.create', 'project.list_all'] as const;
export type TenantCap = (typeof TENANT_CAPS)[number];
export type TenantPermissions = Record<'admin' | 'member', Record<TenantCap, boolean>>;

export const VIEWER_LOCKED = ['create', 'edit', 'archive', 'delete', 'pin', 'restrict', 'categories', 'onboarding'];

export function normalizeProject(p: ProjectPermissions): ProjectPermissions {
  const out = structuredClone(p);
  for (const role of ['maintainer', 'member', 'viewer'] as const) {
    const r = out[role];
    if (role === 'viewer') Object.assign(r, { create: false, edit: 'none', archive: false, delete: false, pin: false, restrict: false, categories: false, onboarding: false });
    if (r.delete) r.archive = true;
    if (r.edit === 'none') { r.pin = false; r.restrict = false; }
  }
  return out;
}

const TENANT_REQUIRES: Partial<Record<TenantCap, TenantCap>> = {
  'settings.edit': 'settings.view', 'members.manage': 'settings.view', 'audit.view': 'settings.view', 'workspace.edit': 'settings.view',
};
export function normalizeTenant(p: TenantPermissions): TenantPermissions {
  const out = structuredClone(p);
  for (const role of ['admin', 'member'] as const) {
    for (const [cap, needs] of Object.entries(TENANT_REQUIRES) as [TenantCap, TenantCap][]) if (out[role][cap]) out[role][needs] = true;
  }
  return out;
}

/** Turning a capability off also turns off anything that depends on it (inverse of the rules above). */
export function tenantDependents(cap: TenantCap): TenantCap[] {
  return (Object.entries(TENANT_REQUIRES) as [TenantCap, TenantCap][]).filter(([, needs]) => needs === cap).map(([c]) => c);
}
