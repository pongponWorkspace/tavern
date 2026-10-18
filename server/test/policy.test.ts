// Unit tests for the pure permission policy (spec §3.3 matrix, §3.4 item rules).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  PROJECT_ROLES,
  RESTRICTABLE_ROLES,
  buildItemRules,
  canManageTenantMember,
  describeItemRules,
  itemPermissions,
  projectCan,
  tenantCan,
  type ProjectAction,
  type ProjectPolicy,
  type ProjectRole,
  type TenantAction,
  type TenantRole,
  permissionsFromPolicy as P,
} from '../src/authz/policy.js';

// Every combination of the four "Policy" cells.
const ALL_POLICIES: ProjectPolicy[] = [];
for (const memberCreate of [true, false])
  for (const memberEdit of ['none', 'own', 'all'] as const)
    for (const maintainerArchive of [true, false])
      for (const memberOnboarding of [true, false])
        ALL_POLICIES.push({ memberCreate, memberEdit, maintainerArchive, memberOnboarding });

const policyLabel = (p: ProjectPolicy) =>
  `create=${p.memberCreate},edit=${p.memberEdit},mArchive=${p.maintainerArchive},onb=${p.memberOnboarding}`;

// ───────────────────────── Tenant matrix ─────────────────────────

describe('tenantCan — §3.3 tenant rows', () => {
  const TENANT_ROLES: TenantRole[] = ['owner', 'admin', 'member'];
  const expected: Record<TenantAction, Record<TenantRole, boolean>> = {
    'tenant.view_settings': { owner: true, admin: true, member: false },
    'tenant.edit_settings': { owner: true, admin: true, member: false },
    'tenant.manage_members': { owner: true, admin: true, member: false },
    'tenant.view_audit': { owner: true, admin: true, member: false },
    'tenant.transfer_ownership': { owner: true, admin: false, member: false },
    'tenant.manage_roles': { owner: true, admin: false, member: false },
    'workspace.create': { owner: true, admin: true, member: false },
    'workspace.edit': { owner: true, admin: true, member: false },
    'project.create': { owner: true, admin: true, member: false },
    'project.list_all': { owner: true, admin: true, member: false },
  };
  for (const [action, byRole] of Object.entries(expected) as [TenantAction, Record<TenantRole, boolean>][]) {
    for (const role of TENANT_ROLES) {
      it(`${role} ${byRole[role] ? 'can' : 'cannot'} ${action}`, () => {
        expect(tenantCan(role, action)).toBe(byRole[role]);
      });
    }
    it(`no tenant role cannot ${action}`, () => {
      expect(tenantCan(null, action)).toBe(false);
      expect(tenantCan(undefined, action)).toBe(false);
    });
  }
  it('default-denies unknown actions', () => {
    expect(tenantCan('owner', 'tenant.delete_everything' as TenantAction)).toBe(false);
  });
});

describe('canManageTenantMember', () => {
  it('nobody can edit the owner or promote to owner', () => {
    for (const actor of ['owner', 'admin', 'member'] as TenantRole[]) {
      expect(canManageTenantMember(actor, 'owner')).toBe(false);
      expect(canManageTenantMember(actor, 'member', 'owner')).toBe(false);
    }
  });
  it('owner manages admins and members', () => {
    expect(canManageTenantMember('owner', 'admin', 'member')).toBe(true);
    expect(canManageTenantMember('owner', 'member', 'admin')).toBe(true);
  });
  it('admin manages members only and cannot create admins', () => {
    expect(canManageTenantMember('admin', 'member')).toBe(true);
    expect(canManageTenantMember('admin', 'member', 'member')).toBe(true);
    expect(canManageTenantMember('admin', 'member', 'admin')).toBe(false);
    expect(canManageTenantMember('admin', 'admin')).toBe(false);
  });
  it('member manages nobody', () => {
    expect(canManageTenantMember('member', 'member')).toBe(false);
  });
});

// ───────────────────────── Project matrix ─────────────────────────

type Cell = boolean | ((p: ProjectPolicy) => boolean);
const PROJECT_MATRIX: Record<ProjectAction, Record<ProjectRole, Cell>> = {
  'project.view': { project_admin: true, maintainer: true, member: true, viewer: true },
  'project.edit': { project_admin: true, maintainer: false, member: false, viewer: false },
  'project.archive': { project_admin: true, maintainer: false, member: false, viewer: false },
  'project.manage_roles': { project_admin: true, maintainer: false, member: false, viewer: false },
  'knowledge.view': { project_admin: true, maintainer: true, member: true, viewer: true },
  'knowledge.create': { project_admin: true, maintainer: true, member: (p) => p.memberCreate, viewer: false },
  'knowledge.view_archived': { project_admin: true, maintainer: (p) => p.maintainerArchive, member: false, viewer: false },
  'knowledge.restrict': { project_admin: true, maintainer: true, member: false, viewer: false },
  'category.manage': { project_admin: true, maintainer: true, member: false, viewer: false },
  'members.view_people': { project_admin: true, maintainer: true, member: true, viewer: true },
  'members.manage': { project_admin: true, maintainer: false, member: false, viewer: false },
  'invitations.manage': { project_admin: true, maintainer: false, member: false, viewer: false },
  'audit.view': { project_admin: true, maintainer: false, member: false, viewer: false },
  'onboarding.manage': { project_admin: true, maintainer: true, member: (p) => p.memberOnboarding, viewer: false },
  'onboarding.complete': { project_admin: true, maintainer: true, member: true, viewer: true },
};

describe('projectCan — §3.3 project rows × every policy combination', () => {
  for (const [action, byRole] of Object.entries(PROJECT_MATRIX) as [ProjectAction, Record<ProjectRole, Cell>][]) {
    for (const role of PROJECT_ROLES) {
      it(`${role} / ${action}`, () => {
        for (const policy of ALL_POLICIES) {
          const cell = byRole[role];
          const want = typeof cell === 'function' ? cell(policy) : cell;
          expect(projectCan(role, action, P(policy)), policyLabel(policy)).toBe(want);
        }
      });
    }
    it(`non-member (null role — includes tenant owner/admin without membership) / ${action}`, () => {
      for (const policy of ALL_POLICIES) {
        expect(projectCan(null, action, P(policy))).toBe(false);
        expect(projectCan(undefined, action, P(policy))).toBe(false);
      }
    });
  }
  it('default-denies unknown actions', () => {
    expect(projectCan('project_admin', 'project.nuke' as ProjectAction, P(DEFAULT_POLICY))).toBe(false);
  });
});

// ───────────────────────── Item permissions ─────────────────────────

const ME = 'user-me';
const OTHER = 'user-other';
const FULL = { canView: true, canEdit: true, canArchive: true };

describe('itemPermissions — base matrix (no rules)', () => {
  for (const policy of ALL_POLICIES) {
    it(`matches §3.3 for ${policyLabel(policy)}`, () => {
      for (const creator of [ME, OTHER]) {
        const own = creator === ME;
        const item = { createdBy: creator };
        expect(itemPermissions('project_admin', P(policy), item, ME, {})).toEqual({
          view: true, edit: true, archive: true, delete: true, pin: true, restrict: true,
        });
        expect(itemPermissions('maintainer', P(policy), item, ME, {})).toEqual({
          view: true, edit: true, archive: policy.maintainerArchive, delete: false, pin: true, restrict: true,
        });
        const memberEdit = policy.memberEdit === 'all' || (policy.memberEdit === 'own' && own);
        expect(itemPermissions('member', P(policy), item, ME, {})).toEqual({
          view: true, edit: memberEdit, archive: false, delete: false, pin: false, restrict: false,
        });
        expect(itemPermissions('viewer', P(policy), item, ME, {})).toEqual({
          view: true, edit: false, archive: false, delete: false, pin: false, restrict: false,
        });
        expect(itemPermissions(null, P(policy), item, ME, {})).toEqual({
          view: false, edit: false, archive: false, delete: false, pin: false, restrict: false,
        });
      }
    });
  }
});

describe('itemPermissions — rules only narrow (§3.4)', () => {
  it('a permissive rule never grants what the base role lacks', () => {
    for (const policy of ALL_POLICIES) {
      for (const role of RESTRICTABLE_ROLES) {
        for (const creator of [ME, OTHER]) {
          const base = itemPermissions(role, P(policy), { createdBy: creator }, ME, {});
          const withRule = itemPermissions(role, P(policy), { createdBy: creator }, ME, { [role]: FULL });
          for (const k of Object.keys(base) as (keyof typeof base)[]) {
            if (!base[k]) expect(withRule[k], `${role} ${k} ${policyLabel(policy)}`).toBe(false);
          }
        }
      }
    }
  });

  it('every rule result is a subset of the base result', () => {
    const bools = [true, false];
    for (const policy of ALL_POLICIES)
      for (const role of RESTRICTABLE_ROLES)
        for (const canView of bools)
          for (const canEdit of bools)
            for (const canArchive of bools) {
              const base = itemPermissions(role, P(policy), { createdBy: ME }, ME, {});
              const r = itemPermissions(role, P(policy), { createdBy: ME }, ME, { [role]: { canView, canEdit, canArchive } });
              for (const k of Object.keys(base) as (keyof typeof base)[]) if (r[k]) expect(base[k]).toBe(true);
              if (!canView) expect(Object.values(r).every((v) => v === false)).toBe(true);
            }
  });

  it('viewer granted edit/archive by a rule still cannot edit, archive or pin', () => {
    expect(itemPermissions('viewer', P(DEFAULT_POLICY), { createdBy: ME }, ME, { viewer: FULL })).toMatchObject({
      view: true, edit: false, archive: false, pin: false, delete: false,
    });
  });

  it('member under memberEdit=none cannot edit even with a permissive rule', () => {
    const policy = { ...DEFAULT_POLICY, memberEdit: 'none' as const };
    expect(itemPermissions('member', P(policy), { createdBy: ME }, ME, { member: FULL }).edit).toBe(false);
  });

  it('maintainer without maintainerArchive cannot archive even with a permissive rule', () => {
    const policy = { ...DEFAULT_POLICY, maintainerArchive: false };
    expect(itemPermissions('maintainer', P(policy), { createdBy: ME }, ME, { maintainer: FULL }).archive).toBe(false);
  });

  it('a rule hiding a role removes every capability', () => {
    for (const role of RESTRICTABLE_ROLES) {
      expect(itemPermissions(role, P(DEFAULT_POLICY), { createdBy: ME }, ME, { [role]: { canView: false, canEdit: true, canArchive: true } })).toEqual({
        view: false, edit: false, archive: false, delete: false, pin: false, restrict: false,
      });
    }
  });

  it('maintainer without edit on an item loses pin and restrict', () => {
    const p = itemPermissions('maintainer', P(DEFAULT_POLICY), { createdBy: OTHER }, ME, { maintainer: { canView: true, canEdit: false, canArchive: true } });
    expect(p).toEqual({ view: true, edit: false, archive: true, delete: false, pin: false, restrict: false });
  });

  it('project admin always has full access regardless of any stored rule', () => {
    const hostile: any = {
      project_admin: { canView: false, canEdit: false, canArchive: false },
      maintainer: { canView: false, canEdit: false, canArchive: false },
      member: { canView: false, canEdit: false, canArchive: false },
      viewer: { canView: false, canEdit: false, canArchive: false },
    };
    for (const policy of ALL_POLICIES) {
      expect(itemPermissions('project_admin', P(policy), { createdBy: OTHER }, ME, hostile)).toEqual({
        view: true, edit: true, archive: true, delete: true, pin: true, restrict: true,
      });
    }
  });

  it('a rule for another role does not affect this role', () => {
    expect(itemPermissions('member', P(DEFAULT_POLICY), { createdBy: ME }, ME, { viewer: { canView: false, canEdit: false, canArchive: false } }).view).toBe(true);
  });

  it('member own-vs-all edit', () => {
    const own = { ...DEFAULT_POLICY, memberEdit: 'own' as const };
    const all = { ...DEFAULT_POLICY, memberEdit: 'all' as const };
    const none = { ...DEFAULT_POLICY, memberEdit: 'none' as const };
    expect(itemPermissions('member', P(own), { createdBy: ME }, ME, {}).edit).toBe(true);
    expect(itemPermissions('member', P(own), { createdBy: OTHER }, ME, {}).edit).toBe(false);
    expect(itemPermissions('member', P(all), { createdBy: OTHER }, ME, {}).edit).toBe(true);
    expect(itemPermissions('member', P(none), { createdBy: ME }, ME, {}).edit).toBe(false);
    // An edit rule further narrows "own".
    expect(itemPermissions('member', P(own), { createdBy: ME }, ME, { member: { canView: true, canEdit: false, canArchive: false } }).edit).toBe(false);
  });
});

// ───────────────────────── buildItemRules / describeItemRules ─────────────────────────

describe('buildItemRules validation', () => {
  it('no lists → no rules and no errors', () => {
    expect(buildItemRules({}, P(DEFAULT_POLICY))).toEqual({ rules: {}, errors: [] });
  });

  it('cannot grant viewer edit access', () => {
    const { errors } = buildItemRules({ editRoles: ['project_admin', 'viewer'] }, P(DEFAULT_POLICY));
    expect(errors.some((e) => /viewer role cannot be given edit/.test(e))).toBe(true);
  });

  it('cannot grant viewer archive access', () => {
    const { errors } = buildItemRules({ archiveRoles: ['project_admin', 'viewer'] }, P(DEFAULT_POLICY));
    expect(errors.some((e) => /viewer role cannot be given archive/.test(e))).toBe(true);
  });

  it('cannot give archive to member', () => {
    for (const policy of ALL_POLICIES) {
      const { errors } = buildItemRules({ archiveRoles: ['project_admin', 'member'] }, P(policy));
      expect(errors.some((e) => /member role cannot be given archive/.test(e))).toBe(true);
    }
  });

  it('cannot give member edit when the project policy is memberEdit=none', () => {
    const { errors } = buildItemRules({ editRoles: ['project_admin', 'member'] }, P({ ...DEFAULT_POLICY, memberEdit: 'none' }));
    expect(errors.some((e) => /member role cannot be given edit/.test(e))).toBe(true);
    expect(buildItemRules({ editRoles: ['project_admin', 'member'] }, P({ ...DEFAULT_POLICY, memberEdit: 'own' })).errors).toEqual([]);
  });

  it('cannot give maintainer archive when maintainerArchive is off', () => {
    const { errors } = buildItemRules({ archiveRoles: ['project_admin', 'maintainer'] }, P({ ...DEFAULT_POLICY, maintainerArchive: false }));
    expect(errors.some((e) => /maintainer role cannot be given archive/.test(e))).toBe(true);
  });

  it('every provided list must include project_admin', () => {
    for (const key of ['visibilityRoles', 'editRoles', 'archiveRoles'] as const) {
      const { errors } = buildItemRules({ [key]: ['maintainer'] }, P(DEFAULT_POLICY));
      expect(errors).toContain('Project Admin always keeps full access and must be included.');
    }
    // The message is de-duplicated.
    const { errors } = buildItemRules({ visibilityRoles: [], editRoles: [], archiveRoles: [] }, P(DEFAULT_POLICY));
    expect(errors.filter((e) => e.startsWith('Project Admin')).length).toBe(1);
  });

  it('edit or archive requires view', () => {
    const r1 = buildItemRules({ visibilityRoles: ['project_admin'], editRoles: ['project_admin', 'maintainer'] }, P(DEFAULT_POLICY));
    expect(r1.errors).toContain('The maintainer role must be able to view an item it can edit or archive.');
    const r2 = buildItemRules({ visibilityRoles: ['project_admin'], archiveRoles: ['project_admin', 'maintainer'] }, P(DEFAULT_POLICY));
    expect(r2.errors).toContain('The maintainer role must be able to view an item it can edit or archive.');
  });

  it('visibility restricted to admin+maintainer hides member and viewer', () => {
    const { rules, errors } = buildItemRules({ visibilityRoles: ['project_admin', 'maintainer'] }, P(DEFAULT_POLICY));
    expect(errors).toEqual([]);
    expect(rules).toEqual({
      member: { canView: false, canEdit: false, canArchive: false },
      viewer: { canView: false, canEdit: false, canArchive: false },
    });
  });

  it('edit restricted to admin narrows maintainer and member edit only', () => {
    const { rules, errors } = buildItemRules({ editRoles: ['project_admin'] }, P(DEFAULT_POLICY));
    expect(errors).toEqual([]);
    expect(rules).toEqual({
      maintainer: { canView: true, canEdit: false, canArchive: true },
      member: { canView: true, canEdit: false, canArchive: true },
    });
    expect(rules.viewer).toBeUndefined();
  });

  it('applied rules never widen the role (build → itemPermissions ⊆ base)', () => {
    const { rules } = buildItemRules({ editRoles: ['project_admin', 'maintainer', 'member'] }, P(DEFAULT_POLICY));
    expect(itemPermissions('viewer', P(DEFAULT_POLICY), { createdBy: ME }, ME, rules).edit).toBe(false);
    expect(itemPermissions('member', P(DEFAULT_POLICY), { createdBy: OTHER }, ME, rules).edit).toBe(false);
  });
});

describe('describeItemRules round-trips through buildItemRules', () => {
  // Each list: omitted, or project_admin plus any subset of the restrictable roles.
  const subsets: (ProjectRole[] | undefined)[] = [undefined];
  for (let mask = 0; mask < 8; mask++) {
    subsets.push(['project_admin', ...RESTRICTABLE_ROLES.filter((_, i) => mask & (1 << i))]);
  }

  it('for every valid input under every policy', () => {
    let checked = 0;
    for (const policy of ALL_POLICIES)
      for (const visibilityRoles of subsets)
        for (const editRoles of subsets)
          for (const archiveRoles of subsets) {
            const first = buildItemRules({ visibilityRoles, editRoles, archiveRoles }, P(policy));
            if (first.errors.length) continue;
            const described = describeItemRules(first.rules, P(policy));
            const again = buildItemRules(described, P(policy));
            expect(again.errors).toEqual([]);
            expect(again.rules).toEqual(first.rules);
            expect(describeItemRules(again.rules, P(policy))).toEqual(described);
            expect(described.restricted).toBe(Object.values(first.rules).some((r) => r && !r.canView));
            for (const list of [described.visibilityRoles, described.editRoles, described.archiveRoles]) {
              expect(list[0]).toBe('project_admin');
            }
            checked++;
          }
    expect(checked).toBeGreaterThan(1000);
  });

  it('describes an unrestricted item as everyone with their base capability', () => {
    expect(describeItemRules({}, P(DEFAULT_POLICY))).toEqual({
      visibilityRoles: ['project_admin', 'maintainer', 'member', 'viewer'],
      editRoles: ['project_admin', 'maintainer', 'member'],
      archiveRoles: ['project_admin', 'maintainer'],
      restricted: false,
    });
  });
});
