-- Tavern — initial schema (spec §8).
-- Conventions:
--   * Every tenant-owned row carries tenant_id directly.
--   * Child → parent references are composite (tenant_id/project_id, id) so the
--     database itself rejects cross-tenant / cross-project relationships (§8.2).
--   * Timestamps are timestamptz (stored UTC).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────────────────────── Identity ─────────────────────────────

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  display_name      text NOT NULL,
  avatar_url        text,
  password_hash     text,
  email_verified_at timestamptz,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE auth_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google','saml','oidc')),
  provider_subject text NOT NULL,
  provider_email   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  UNIQUE (provider, provider_subject)
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  csrf_token   text NOT NULL,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Single-use, expiring tokens for email verification and password reset.
CREATE TABLE email_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Outbound mail. In development this table is the "test email sink" (§14.3).
CREATE TABLE email_outbox (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email   text NOT NULL,
  subject    text NOT NULL,
  body_text  text NOT NULL,
  status     text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

-- ───────────────────────────── Tenancy ─────────────────────────────

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deletion_pending','deleted')),
  -- Open question #13 — documented default in docs/decisions.md
  project_invites_add_tenant_members boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','member')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
-- Exactly one owner per tenant; ownership moves through a transfer transaction.
CREATE UNIQUE INDEX tenant_one_owner ON tenant_memberships (tenant_id) WHERE role = 'owner';

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  description text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, id)
);

CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  name          text NOT NULL,
  slug          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  owner_user_id uuid REFERENCES users(id),
  contact       text NOT NULL DEFAULT '',
  -- "Policy" cells of the permission matrix (§3.3), configurable per project.
  policy_member_create      boolean NOT NULL DEFAULT true,
  policy_member_edit        text    NOT NULL DEFAULT 'own' CHECK (policy_member_edit IN ('none','own','all')),
  policy_maintainer_archive boolean NOT NULL DEFAULT true,
  policy_member_onboarding  boolean NOT NULL DEFAULT false,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  version       integer NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, slug),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces (tenant_id, id)
);

CREATE TABLE project_memberships (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('project_admin','maintainer','member','viewer')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
  invited_by uuid REFERENCES users(id),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  -- An active project membership requires a tenant membership row (§8.2);
  -- the *active* part is enforced in the authorization layer.
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX project_memberships_user_idx ON project_memberships (user_id) WHERE status = 'active';

-- ───────────────────────────── Knowledge ─────────────────────────────

CREATE TABLE knowledge_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  project_id  uuid NOT NULL,
  name        text NOT NULL,
  slug        text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug),
  UNIQUE (project_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  project_id        uuid NOT NULL,
  storage_key       text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  safe_filename     text NOT NULL,
  declared_mime     text NOT NULL,
  mime_type         text,
  size_bytes        bigint NOT NULL,
  checksum_sha256   text,
  upload_state      text NOT NULL DEFAULT 'initiated' CHECK (upload_state IN ('initiated','uploaded','completed')),
  scan_status       text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','quarantined','failed')),
  scan_detail       text,
  uploaded_by       uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (project_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  project_id    uuid NOT NULL,
  category_id   uuid,
  type          text NOT NULL CHECK (type IN ('external_link','uploaded_file','internal_document')),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description   text NOT NULL DEFAULT '',
  external_url  text,
  normalized_url text,
  file_id       uuid,
  owner_user_id uuid REFERENCES users(id),
  created_by    uuid NOT NULL REFERENCES users(id),
  updated_by    uuid NOT NULL REFERENCES users(id),
  is_pinned     boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  deleted_at    timestamptz,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'B')
  ) STORED,
  UNIQUE (project_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, category_id) REFERENCES knowledge_categories (project_id, id),
  FOREIGN KEY (project_id, file_id) REFERENCES files (project_id, id),
  -- Type-specific fields must be consistent (§8.1).
  CONSTRAINT knowledge_type_fields CHECK (
    (type = 'external_link'     AND external_url IS NOT NULL AND file_id IS NULL) OR
    (type = 'uploaded_file'     AND file_id IS NOT NULL AND external_url IS NULL) OR
    (type = 'internal_document' AND file_id IS NULL AND external_url IS NULL)
  )
);
CREATE INDEX knowledge_items_list_idx ON knowledge_items (tenant_id, project_id, status, updated_at DESC, id DESC);
CREATE INDEX knowledge_items_type_idx ON knowledge_items (project_id, type);
CREATE INDEX knowledge_items_category_idx ON knowledge_items (project_id, category_id);
CREATE INDEX knowledge_items_search_idx ON knowledge_items USING gin (search_vector);
CREATE INDEX knowledge_items_url_idx ON knowledge_items (project_id, normalized_url);

CREATE TABLE knowledge_documents (
  knowledge_item_id uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  project_id        uuid NOT NULL,
  content_md        text NOT NULL DEFAULT '',
  updated_by        uuid NOT NULL REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, knowledge_item_id) REFERENCES knowledge_items (project_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  project_id uuid NOT NULL,
  name       text NOT NULL,
  slug       text NOT NULL,
  UNIQUE (project_id, slug),
  UNIQUE (project_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE knowledge_item_tags (
  project_id        uuid NOT NULL,
  knowledge_item_id uuid NOT NULL,
  tag_id            uuid NOT NULL,
  PRIMARY KEY (knowledge_item_id, tag_id),
  FOREIGN KEY (project_id, knowledge_item_id) REFERENCES knowledge_items (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, tag_id) REFERENCES knowledge_tags (project_id, id) ON DELETE CASCADE
);

-- Item-level restrictions (§3.4). A missing row for a role = no restriction.
CREATE TABLE knowledge_item_access_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  project_id        uuid NOT NULL,
  knowledge_item_id uuid NOT NULL,
  role              text NOT NULL CHECK (role IN ('maintainer','member','viewer')),
  can_view          boolean NOT NULL,
  can_edit          boolean NOT NULL,
  can_archive       boolean NOT NULL,
  created_by        uuid NOT NULL REFERENCES users(id),
  updated_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_item_id, role),
  FOREIGN KEY (project_id, knowledge_item_id) REFERENCES knowledge_items (project_id, id) ON DELETE CASCADE
);

-- ───────────────────────────── Invitations ─────────────────────────────

CREATE TABLE invitations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id        uuid,
  token_hash        text NOT NULL UNIQUE,
  target_role       text NOT NULL,
  email_restriction text,
  allowed_domain    text,
  max_uses          integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 500),
  use_count         integer NOT NULL DEFAULT 0,
  expires_at        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired','accepted','exhausted')),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES users(id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT invitation_role_scope CHECK (
    (project_id IS NULL     AND target_role IN ('admin','member')) OR
    (project_id IS NOT NULL AND target_role IN ('project_admin','maintainer','member','viewer'))
  ),
  CONSTRAINT invitation_use_limit CHECK (use_count <= max_uses)
);
CREATE INDEX invitations_scope_idx ON invitations (tenant_id, project_id, created_at DESC);

CREATE TABLE invitation_acceptances (
  invitation_id uuid NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (invitation_id, user_id)
);

-- ───────────────────────────── Onboarding ─────────────────────────────

CREATE TABLE onboarding_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  project_id  uuid NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  target_role text CHECK (target_role IN ('project_admin','maintainer','member','viewer')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by  uuid NOT NULL REFERENCES users(id),
  updated_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE onboarding_steps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  project_id        uuid NOT NULL,
  template_id       uuid NOT NULL,
  knowledge_item_id uuid,
  title             text NOT NULL,
  instructions      text NOT NULL DEFAULT '',
  sort_order        integer NOT NULL DEFAULT 0,
  is_required       boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, template_id) REFERENCES onboarding_templates (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, knowledge_item_id) REFERENCES knowledge_items (project_id, id) ON DELETE SET NULL (knowledge_item_id)
);

CREATE TABLE onboarding_progress (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  project_id   uuid NOT NULL,
  template_id  uuid NOT NULL,
  step_id      uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL CHECK (status IN ('not_started','completed','skipped')),
  completed_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (step_id, user_id),
  FOREIGN KEY (project_id, step_id) REFERENCES onboarding_steps (project_id, id) ON DELETE CASCADE
);

-- ───────────────────────────── Audit ─────────────────────────────

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid,
  project_id    uuid,
  actor_user_id uuid,
  action        text NOT NULL,
  target_type   text NOT NULL,
  target_id     text,
  outcome       text NOT NULL CHECK (outcome IN ('success','denied','failure')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id    text,
  ip_hash       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_project_idx ON audit_logs (project_id, created_at DESC, id DESC);
CREATE INDEX audit_logs_tenant_idx ON audit_logs (tenant_id, created_at DESC, id DESC);

-- Append-only for the application role (§FR-011).
CREATE FUNCTION audit_logs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();
