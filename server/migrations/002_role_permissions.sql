-- Customizable role → capability matrices (RBAC table), per organization and per project.
-- Stored as JSON so new capabilities can be added without a migration; the
-- application normalizes it (fills defaults, enforces guard rails) on every read.

ALTER TABLE tenants  ADD COLUMN role_permissions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN role_permissions jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Carry the four legacy project "policy" switches into the matrix, then drop them.
UPDATE projects SET role_permissions = jsonb_build_object(
  'maintainer', jsonb_build_object('archive', policy_maintainer_archive),
  'member', jsonb_build_object(
    'create', policy_member_create,
    'edit', policy_member_edit,
    'onboarding', policy_member_onboarding
  )
);

ALTER TABLE projects
  DROP COLUMN policy_member_create,
  DROP COLUMN policy_member_edit,
  DROP COLUMN policy_maintainer_archive,
  DROP COLUMN policy_member_onboarding;
