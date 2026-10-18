import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Lock, Minus } from 'lucide-react';
import { api } from '../api';
import { normalizeProject, normalizeTenant, tenantDependents, type ProjectPermissions, type TenantCap, type TenantPermissions } from '../lib/rbac';
import { RoleMatrix, type MatrixRow } from './RoleMatrix';
import { ErrorAlert, RoleBadge, Spinner, TenantRoleBadge, useToast } from './ui';
import { t } from '../lib/i18n';

const ESCALATION = 'Only Project Admins — it controls who has access, so it can’t be delegated.';
const VIEWER_RO = 'Viewers are read-only.';
const viewerLock = { get viewer() { return t(VIEWER_RO); } };

const PROJECT_ROWS: MatrixRow[] = [
  { get group() { return t("Knowledge"); }, key: 'view', get label() { return t("View knowledge"); }, get hint() { return t("Items their role is allowed to see"); }, get everyone() { return t("Everyone in the project can view knowledge shared with their role."); } },
  { get group() { return t("Knowledge"); }, key: 'create', get label() { return t("Add links, files and documents"); }, lockedFor: viewerLock },
  { get group() { return t("Knowledge"); }, key: 'edit', get label() { return t("Edit items"); }, get hint() { return t("Details and document content"); }, kind: 'scope', lockedFor: viewerLock },
  { get group() { return t("Knowledge"); }, key: 'pin', get label() { return t("Pin to the overview"); }, get hint() { return t("Needs an edit right"); }, lockedFor: viewerLock },
  { get group() { return t("Knowledge"); }, key: 'restrict', get label() { return t("Restrict who can see an item"); }, get hint() { return t("Can tighten, never loosen, an admin’s limits"); }, lockedFor: viewerLock },
  { get group() { return t("Knowledge"); }, key: 'archive', get label() { return t("Archive and restore items"); }, get hint() { return t("Also shows archived items"); }, lockedFor: viewerLock },
  { get group() { return t("Knowledge"); }, key: 'delete', get label() { return t("Delete items permanently"); }, get hint() { return t("Archived items only"); }, lockedFor: viewerLock },
  { get group() { return t("Knowledge"); }, key: 'categories', get label() { return t("Manage categories"); }, lockedFor: viewerLock },
  { get group() { return t("Onboarding"); }, key: 'complete', get label() { return t("Complete the onboarding checklist"); }, get everyone() { return t("Everyone can track their own onboarding."); } },
  { get group() { return t("Onboarding"); }, key: 'onboarding', get label() { return t("Configure onboarding steps"); }, lockedFor: viewerLock },
  { get group() { return t("Project administration"); }, key: 'audit', get label() { return t("View the activity log"); } },
  { get group() { return t("Project administration"); }, key: 'members', get label() { return t("Manage members and their roles"); }, get fullOnly() { return t(ESCALATION); } },
  { get group() { return t("Project administration"); }, key: 'invitations', get label() { return t("Create and revoke invitation links"); }, get fullOnly() { return t(ESCALATION); } },
  { get group() { return t("Project administration"); }, key: 'settings', get label() { return t("Edit project details, archive the project"); }, get fullOnly() { return t(ESCALATION); } },
  { get group() { return t("Project administration"); }, key: 'roles', get label() { return t("Change this permissions table"); }, get fullOnly() { return t(ESCALATION); } },
];

const OWNER_ONLY = 'Only the Owner — it changes who controls the organization.';
const TENANT_ROWS: MatrixRow[] = [
  { get group() { return t("Organization"); }, key: 'settings.view', get label() { return t("Open organization settings"); }, get hint() { return t("Needed for the items below that live there"); } },
  { get group() { return t("Organization"); }, key: 'settings.edit', get label() { return t("Edit organization settings"); } },
  { get group() { return t("Organization"); }, key: 'members.manage', get label() { return t("Manage members"); }, get hint() { return t("Invite, suspend and remove. Can’t make anyone an Admin."); } },
  { get group() { return t("Organization"); }, key: 'audit.view', get label() { return t("View the organization audit log"); } },
  { get group() { return t("Workspaces and projects"); }, key: 'workspace.create', get label() { return t("Create workspaces"); } },
  { get group() { return t("Workspaces and projects"); }, key: 'workspace.edit', get label() { return t("Rename and archive workspaces"); } },
  { get group() { return t("Workspaces and projects"); }, key: 'project.create', get label() { return t("Create projects"); }, get hint() { return t("The creator becomes its Project Admin"); } },
  { get group() { return t("Workspaces and projects"); }, key: 'project.list_all', get label() { return t("See every project’s name"); }, get hint() { return t("Content still needs a project membership"); } },
  { get group() { return t("Ownership"); }, key: 'transfer', get label() { return t("Transfer ownership"); }, get fullOnly() { return t(OWNER_ONLY); } },
  { get group() { return t("Ownership"); }, key: 'roles', get label() { return t("Change this permissions table"); }, get fullOnly() { return t(OWNER_ONLY); } },
];

function Legend() {
  return (
    <div className="rm-legend" aria-hidden="true">
      <span><Check size={14} className="pin" />{' '}{t("Allowed")}</span>
      <span><Minus size={14} />{' '}{t("Not allowed")}</span>
      <span><Lock size={12} />{' '}{t("Fixed — hover for the reason")}</span>
    </div>
  );
}

/** Edit-in-place state with a sticky save bar, shared by both tables. */
function useDraft<T>(saved: T) {
  const [draft, setDraft] = useState<T>(saved);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  return { draft, setDraft, dirty, reset: () => setDraft(saved) };
}

function SaveBar({ dirty, busy, onSave, onDiscard }: { dirty: boolean; busy: boolean; onSave: () => void; onDiscard: () => void }) {
  if (!dirty) return null;
  return (
    <div className="save-bar" role="region" aria-label={t("Unsaved permission changes")}>
      <span className="muted">{t("Unsaved changes")}</span>
      <span className="spacer" />
      <button className="btn" onClick={onDiscard} disabled={busy}>{t("Discard")}</button>
      <button className="btn primary" onClick={onSave} disabled={busy}>{busy ? <Spinner /> : t("Save permissions")}</button>
    </div>
  );
}

export function ProjectRoleTable({ projectId, value, editable, myRole }: { projectId: string; value: ProjectPermissions; editable: boolean; myRole?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { draft, setDraft, dirty, reset } = useDraft(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${projectId}/role-permissions`, { method: 'PUT', body: { permissions: draft } });
      await qc.invalidateQueries();
      toast(t("Permissions saved — they apply on everyone’s next action"));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <ErrorAlert error={error} />
      <RoleMatrix
        caption={t("Project roles and what each can do")}
        highlight={myRole}
        readOnly={!editable}
        columns={[
          { key: 'project_admin', label: t("Project Admin"), header: <RoleBadge role="project_admin" />, full: true },
          { key: 'maintainer', label: t("Maintainer"), header: <RoleBadge role="maintainer" /> },
          { key: 'member', label: t("Member"), header: <RoleBadge role="member" /> },
          { key: 'viewer', label: t("Viewer"), header: <RoleBadge role="viewer" /> },
        ]}
        rows={PROJECT_ROWS}
        value={draft as any}
        onChange={(role, cap, next) => setDraft((d) => normalizeProject({ ...d, [role]: { ...(d as any)[role], [cap]: next } }))}
      />
      <Legend />
      {editable && <SaveBar dirty={dirty} busy={busy} onSave={save} onDiscard={reset} />}
    </div>
  );
}

export function TenantRoleTable({ tenantId, value, editable, myRole }: { tenantId: string; value: TenantPermissions; editable: boolean; myRole?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { draft, setDraft, dirty, reset } = useDraft(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/tenants/${tenantId}/role-permissions`, { method: 'PUT', body: { permissions: draft } });
      await qc.invalidateQueries();
      toast(t("Permissions saved — they apply on everyone’s next action"));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const change = (role: string, cap: string, next: unknown) =>
    setDraft((d) => {
      const row = { ...(d as any)[role], [cap]: next };
      // Turning something off also turns off what depends on it; turning on pulls in what it needs.
      if (!next) for (const dep of tenantDependents(cap as TenantCap)) row[dep] = false;
      return normalizeTenant({ ...d, [role]: row });
    });

  return (
    <div>
      <ErrorAlert error={error} />
      <RoleMatrix
        caption={t("Organization roles and what each can do")}
        highlight={myRole}
        readOnly={!editable}
        columns={[
          { key: 'owner', label: t("Owner"), header: <TenantRoleBadge role="owner" />, full: true },
          { key: 'admin', label: t("Admin"), header: <TenantRoleBadge role="admin" /> },
          { key: 'member', label: t("Member"), header: <TenantRoleBadge role="member" /> },
        ]}
        rows={TENANT_ROWS}
        value={draft as any}
        onChange={change}
      />
      <Legend />
      {editable && <SaveBar dirty={dirty} busy={busy} onSave={save} onDiscard={reset} />}
    </div>
  );
}
