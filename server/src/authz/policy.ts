// Pure authorization policy — the single source of truth for role-based access
// (spec §3.3) and item-level restrictions (§3.4). No I/O here so every rule can
// be unit-tested exhaustively. Default deny: anything not listed is false.
//
// Each organization and each project stores a customizable role → capability
// matrix. Guard rails keep it safe to customize:
//   * Owner / Project Admin always hold every capability (no lock-out).
//   * Capabilities that could be used to escalate privileges (managing members,
//     invitations, settings and this matrix itself) stay owner/admin-only.
//   * Viewers are read-only by definition; only read capabilities can be granted.
// Item rules (§3.4) still only narrow whatever the matrix grants.

export type TenantRole = 'owner' | 'admin' | 'member';
export type ProjectRole = 'project_admin' | 'maintainer' | 'member' | 'viewer';
export const PROJECT_ROLES: ProjectRole[] = ['project_admin', 'maintainer', 'member', 'viewer'];
export const RESTRICTABLE_ROLES = ['maintainer', 'member', 'viewer'] as const;
export type RestrictableRole = (typeof RESTRICTABLE_ROLES)[number];

// ═════════════════════════ Organization (tenant) matrix ═════════════════════════

export const TENANT_CAPABILITIES = [
  'settings.view',
  'settings.edit',
  'members.manage',
  'audit.view',
  'workspace.create',
  'workspace.edit',
  'project.create',
  'project.list_all',
] as const;
export type TenantCapability = (typeof TENANT_CAPABILITIES)[number];
export type EditableTenantRole = 'admin' | 'member';
export type TenantPermissions = Record<EditableTenantRole, Record<TenantCapability, boolean>>;

const allTenant = (v: boolean) => Object.fromEntries(TENANT_CAPABILITIES.map((c) => [c, v])) as Record<TenantCapability, boolean>;
export const DEFAULT_TENANT_PERMISSIONS: TenantPermissions = { admin: allTenant(true), member: allTenant(false) };

/** Capabilities that need another one to be usable (e.g. you can't edit settings you can't open). */
const TENANT_REQUIRES: Partial<Record<TenantCapability, TenantCapability>> = {
  'settings.edit': 'settings.view',
  'members.manage': 'settings.view',
  'audit.view': 'settings.view',
  'workspace.edit': 'settings.view',
};

/** Fill gaps from the defaults and apply dependency rules. Unknown keys are dropped. */
export function normalizeTenantPermissions(input: unknown): TenantPermissions {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, Record<string, unknown>>;
  const out = {} as TenantPermissions;
  for (const role of ['admin', 'member'] as const) {
    const row = { ...DEFAULT_TENANT_PERMISSIONS[role] };
    for (const cap of TENANT_CAPABILITIES) if (typeof src[role]?.[cap] === 'boolean') row[cap] = src[role][cap] as boolean;
    for (const [cap, needs] of Object.entries(TENANT_REQUIRES) as [TenantCapability, TenantCapability][]) {
      if (row[cap]) row[needs] = true;
    }
    out[role] = row;
  }
  return out;
}

export type TenantAction =
  | 'tenant.view_settings'
  | 'tenant.edit_settings'
  | 'tenant.manage_members'
  | 'tenant.view_audit'
  | 'tenant.transfer_ownership'
  | 'tenant.manage_roles'
  | 'workspace.create'
  | 'workspace.edit'
  | 'project.create'
  | 'project.list_all';

const TENANT_ACTION_CAP: Partial<Record<TenantAction, TenantCapability>> = {
  'tenant.view_settings': 'settings.view',
  'tenant.edit_settings': 'settings.edit',
  'tenant.manage_members': 'members.manage',
  'tenant.view_audit': 'audit.view',
  'workspace.create': 'workspace.create',
  'workspace.edit': 'workspace.edit',
  'project.create': 'project.create',
  'project.list_all': 'project.list_all',
};

export function tenantCan(
  role: TenantRole | null | undefined,
  action: TenantAction,
  perms: TenantPermissions = DEFAULT_TENANT_PERMISSIONS,
): boolean {
  if (!role) return false;
  // Owner-only, never delegable: they change who controls the organization.
  if (action === 'tenant.transfer_ownership' || action === 'tenant.manage_roles') return role === 'owner';
  const cap = TENANT_ACTION_CAP[action];
  if (!cap) return false;
  if (role === 'owner') return true;
  return Boolean(perms[role]?.[cap]);
}

/**
 * Who may change whom. The owner manages everyone but themselves; anyone else
 * holding "manage members" may only manage plain members and never promote to
 * admin — so a delegated permission can't be used to escalate.
 */
export function canManageTenantMember(
  actor: TenantRole,
  target: TenantRole,
  newRole?: TenantRole,
  actorMayManage: boolean = actor === 'owner' || actor === 'admin',
): boolean {
  if (target === 'owner' || newRole === 'owner') return false;
  if (actor === 'owner') return true;
  if (!actorMayManage) return false;
  return target === 'member' && (newRole === undefined || newRole === 'member');
}

// ═════════════════════════ Project matrix ═════════════════════════
// Tenant roles never appear here: tenant owners/admins must hold a project
// membership to touch project content (§3.2, footnote * of §3.3).

export type EditScope = 'none' | 'own' | 'all';
export interface ProjectRolePermissions {
  create: boolean; // add links, files, documents
  edit: EditScope; // edit item details and document content
  archive: boolean; // archive / restore items and see archived items
  delete: boolean; // permanently delete archived items
  pin: boolean; // pin to the project overview
  restrict: boolean; // narrow who can see/edit an item
  categories: boolean; // create, rename, delete categories
  onboarding: boolean; // configure onboarding steps
  audit: boolean; // read the project activity log
}
export type ProjectCapability = keyof ProjectRolePermissions;
export const PROJECT_CAPABILITIES: ProjectCapability[] = ['create', 'edit', 'archive', 'delete', 'pin', 'restrict', 'categories', 'onboarding', 'audit'];
export type ProjectPermissions = Record<RestrictableRole, ProjectRolePermissions>;

export const DEFAULT_PROJECT_PERMISSIONS: ProjectPermissions = {
  maintainer: { create: true, edit: 'all', archive: true, delete: false, pin: true, restrict: true, categories: true, onboarding: true, audit: false },
  member: { create: true, edit: 'own', archive: false, delete: false, pin: false, restrict: false, categories: false, onboarding: false, audit: false },
  viewer: { create: false, edit: 'none', archive: false, delete: false, pin: false, restrict: false, categories: false, onboarding: false, audit: false },
};

/** Viewers are read-only: these can never be granted to them. */
export const VIEWER_LOCKED: ProjectCapability[] = ['create', 'edit', 'archive', 'delete', 'pin', 'restrict', 'categories', 'onboarding'];

/**
 * Fill gaps from the defaults, force guard rails, and apply dependencies:
 * delete needs archive (only archived items can be deleted), pin and restrict
 * need some edit right.
 */
export function normalizeProjectPermissions(input: unknown): ProjectPermissions {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, Record<string, unknown>>;
  const out = {} as ProjectPermissions;
  for (const role of RESTRICTABLE_ROLES) {
    const row: ProjectRolePermissions = { ...DEFAULT_PROJECT_PERMISSIONS[role] };
    const given = src[role] ?? {};
    for (const cap of PROJECT_CAPABILITIES) {
      const v = given[cap];
      if (cap === 'edit') {
        if (v === 'none' || v === 'own' || v === 'all') row.edit = v;
      } else if (typeof v === 'boolean') {
        (row as any)[cap] = v;
      }
    }
    if (role === 'viewer') {
      for (const cap of VIEWER_LOCKED) (row as any)[cap] = cap === 'edit' ? 'none' : false;
    }
    if (row.delete) row.archive = true;
    if (row.edit === 'none') {
      row.pin = false;
      row.restrict = false;
    }
    out[role] = row;
  }
  return out;
}

/** Legacy four-switch project policy (pre-matrix). Kept to migrate data and express tests. */
export interface ProjectPolicy {
  memberCreate: boolean;
  memberEdit: EditScope;
  maintainerArchive: boolean;
  memberOnboarding: boolean;
}
export const DEFAULT_POLICY: ProjectPolicy = { memberCreate: true, memberEdit: 'own', maintainerArchive: true, memberOnboarding: false };

export function permissionsFromPolicy(p: Partial<ProjectPolicy>): ProjectPermissions {
  const d = DEFAULT_PROJECT_PERMISSIONS;
  return normalizeProjectPermissions({
    maintainer: { ...d.maintainer, archive: p.maintainerArchive ?? DEFAULT_POLICY.maintainerArchive },
    member: {
      ...d.member,
      create: p.memberCreate ?? DEFAULT_POLICY.memberCreate,
      edit: p.memberEdit ?? DEFAULT_POLICY.memberEdit,
      onboarding: p.memberOnboarding ?? DEFAULT_POLICY.memberOnboarding,
    },
    viewer: d.viewer,
  });
}

export type ProjectAction =
  | 'project.view'
  | 'project.edit'
  | 'project.archive'
  | 'project.manage_roles'
  | 'knowledge.view'
  | 'knowledge.create'
  | 'knowledge.view_archived'
  | 'knowledge.restrict' // set item-level access rules
  | 'category.manage'
  | 'members.view_people'
  | 'members.manage'
  | 'invitations.manage'
  | 'audit.view'
  | 'onboarding.manage'
  | 'onboarding.complete';

const roleRow = (perms: ProjectPermissions, role: RestrictableRole) => perms[role] ?? DEFAULT_PROJECT_PERMISSIONS[role];

export function projectCan(role: ProjectRole | null | undefined, action: ProjectAction, perms: ProjectPermissions): boolean {
  if (!role) return false;
  switch (action) {
    case 'project.view':
    case 'knowledge.view':
    case 'members.view_people':
    case 'onboarding.complete':
      return true;
    // Admin-only: these control who has access, so delegating them would allow escalation.
    case 'project.edit':
    case 'project.archive':
    case 'project.manage_roles':
    case 'members.manage':
    case 'invitations.manage':
      return role === 'project_admin';
  }
  if (role === 'project_admin') {
    return ['knowledge.create', 'knowledge.view_archived', 'knowledge.restrict', 'category.manage', 'audit.view', 'onboarding.manage'].includes(action);
  }
  const r = roleRow(perms, role);
  switch (action) {
    case 'knowledge.create':
      return r.create;
    case 'knowledge.view_archived':
      return r.archive;
    case 'knowledge.restrict':
      return r.restrict && r.edit !== 'none';
    case 'category.manage':
      return r.categories;
    case 'audit.view':
      return r.audit;
    case 'onboarding.manage':
      return r.onboarding;
    default:
      return false;
  }
}

// ───────────────────────── Item-level access ─────────────────────────

export interface ItemRule {
  canView: boolean;
  canEdit: boolean;
  canArchive: boolean;
}
export type ItemRules = Partial<Record<RestrictableRole, ItemRule>>;

export interface ItemPermissions {
  view: boolean;
  edit: boolean;
  archive: boolean;
  delete: boolean;
  pin: boolean;
  restrict: boolean;
}

const NONE: ItemPermissions = { view: false, edit: false, archive: false, delete: false, pin: false, restrict: false };

/** The role's project-level capability on an item before any item rule is applied. */
export function baseItemPermissions(
  role: ProjectRole,
  perms: ProjectPermissions,
  isCreator: boolean,
): Omit<ItemPermissions, 'restrict'> {
  if (role === 'project_admin') return { view: true, edit: true, archive: true, delete: true, pin: true };
  const r = roleRow(perms, role);
  return {
    view: true,
    edit: r.edit === 'all' || (r.edit === 'own' && isCreator),
    archive: r.archive,
    delete: r.delete,
    pin: r.pin,
  };
}

/**
 * Effective permissions = base ∧ item rule. Rules can only narrow (§3.4):
 * a rule's `true` never adds a capability the base lacks. Project Admin
 * always has full access to items in their project.
 */
export function itemPermissions(
  role: ProjectRole | null | undefined,
  perms: ProjectPermissions,
  item: { createdBy: string; status?: string },
  userId: string,
  rules: ItemRules,
): ItemPermissions {
  if (!role) return NONE;
  const base = baseItemPermissions(role, perms, item.createdBy === userId);
  if (role === 'project_admin') return { ...base, restrict: true };
  const rule = rules[role];
  const view = base.view && (rule ? rule.canView : true);
  if (!view) return NONE;
  const edit = base.edit && (rule ? rule.canEdit : true);
  const archive = base.archive && (rule ? rule.canArchive : true);
  return {
    view,
    edit,
    archive,
    delete: base.delete && archive,
    pin: base.pin && edit,
    restrict: roleRow(perms, role).restrict && edit,
  };
}

/**
 * Turn the API's role lists into stored narrowing rules and reject requests
 * that would grant more than a role's base capability (§9.8 step 5).
 * Lists that are omitted mean "no restriction" for that capability.
 */
export function buildItemRules(
  input: { visibilityRoles?: ProjectRole[]; editRoles?: ProjectRole[]; archiveRoles?: ProjectRole[] },
  perms: ProjectPermissions,
): { rules: ItemRules; errors: string[] } {
  const errors: string[] = [];
  const rules: ItemRules = {};
  const includes = (list: ProjectRole[] | undefined, r: ProjectRole) => (list ? list.includes(r) : true);

  for (const list of [input.visibilityRoles, input.editRoles, input.archiveRoles]) {
    if (list && !list.includes('project_admin')) errors.push('Project Admin always keeps full access and must be included.');
  }

  for (const role of RESTRICTABLE_ROLES) {
    const base = baseItemPermissions(role, perms, true); // best case (creator) for validation
    const canView = includes(input.visibilityRoles, role);
    const wantsEdit = input.editRoles ? input.editRoles.includes(role) : false;
    const wantsArchive = input.archiveRoles ? input.archiveRoles.includes(role) : false;

    if (wantsEdit && !base.edit) errors.push(`The ${role} role cannot be given edit access on this project.`);
    if (wantsArchive && !base.archive) errors.push(`The ${role} role cannot be given archive access on this project.`);
    if ((wantsEdit || wantsArchive) && !canView) errors.push(`The ${role} role must be able to view an item it can edit or archive.`);

    // Only narrow capabilities the role actually has; a missing base capability needs no rule.
    const rule: ItemRule = {
      canView,
      canEdit: canView && (base.edit ? includes(input.editRoles, role) : true),
      canArchive: canView && (base.archive ? includes(input.archiveRoles, role) : true),
    };
    if (!rule.canView || !rule.canEdit || !rule.canArchive) rules[role] = rule;
  }
  return { rules, errors: [...new Set(errors)] };
}

/**
 * Expand stored rules back into role lists (effective capability per role),
 * shaped so they round-trip through buildItemRules unchanged.
 */
export function describeItemRules(rules: ItemRules, perms: ProjectPermissions) {
  const visibilityRoles: ProjectRole[] = ['project_admin'];
  const editRoles: ProjectRole[] = ['project_admin'];
  const archiveRoles: ProjectRole[] = ['project_admin'];
  for (const role of RESTRICTABLE_ROLES) {
    const r = rules[role];
    const base = baseItemPermissions(role, perms, true);
    const view = !r || r.canView;
    if (view) visibilityRoles.push(role);
    if (view && base.edit && (!r || r.canEdit)) editRoles.push(role);
    if (view && base.archive && (!r || r.canArchive)) archiveRoles.push(role);
  }
  return { visibilityRoles, editRoles, archiveRoles, restricted: Object.values(rules).some((r) => r && !r.canView) };
}
