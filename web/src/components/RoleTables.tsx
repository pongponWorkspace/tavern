import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Lock, Minus } from 'lucide-react';
import { api } from '../api';
import { normalizeProject, normalizeTenant, tenantDependents, type ProjectPermissions, type TenantCap, type TenantPermissions } from '../lib/rbac';
import { RoleMatrix, type MatrixRow } from './RoleMatrix';
import { ErrorAlert, RoleBadge, Spinner, TenantRoleBadge, useToast } from './ui';

const ESCALATION = 'Only Project Admins — it controls who has access, so it can’t be delegated.';
const VIEWER_RO = 'Viewers are read-only.';
const viewerLock = { viewer: VIEWER_RO };

const PROJECT_ROWS: MatrixRow[] = [
  { group: 'Knowledge', key: 'view', label: 'View knowledge', hint: 'Items their role is allowed to see', everyone: 'Everyone in the project can view knowledge shared with their role.' },
  { group: 'Knowledge', key: 'create', label: 'Add links, files and documents', lockedFor: viewerLock },
  { group: 'Knowledge', key: 'edit', label: 'Edit items', hint: 'Details and document content', kind: 'scope', lockedFor: viewerLock },
  { group: 'Knowledge', key: 'pin', label: 'Pin to the overview', hint: 'Needs an edit right', lockedFor: viewerLock },
  { group: 'Knowledge', key: 'restrict', label: 'Restrict who can see an item', hint: 'Can tighten, never loosen, an admin’s limits', lockedFor: viewerLock },
  { group: 'Knowledge', key: 'archive', label: 'Archive and restore items', hint: 'Also shows archived items', lockedFor: viewerLock },
  { group: 'Knowledge', key: 'delete', label: 'Delete items permanently', hint: 'Archived items only', lockedFor: viewerLock },
  { group: 'Knowledge', key: 'categories', label: 'Manage categories', lockedFor: viewerLock },
  { group: 'Onboarding', key: 'complete', label: 'Complete the onboarding checklist', everyone: 'Everyone can track their own onboarding.' },
  { group: 'Onboarding', key: 'onboarding', label: 'Configure onboarding steps', lockedFor: viewerLock },
  { group: 'Project administration', key: 'audit', label: 'View the activity log' },
  { group: 'Project administration', key: 'members', label: 'Manage members and their roles', fullOnly: ESCALATION },
  { group: 'Project administration', key: 'invitations', label: 'Create and revoke invitation links', fullOnly: ESCALATION },
  { group: 'Project administration', key: 'settings', label: 'Edit project details, archive the project', fullOnly: ESCALATION },
  { group: 'Project administration', key: 'roles', label: 'Change this permissions table', fullOnly: ESCALATION },
];

const OWNER_ONLY = 'Only the Owner — it changes who controls the organization.';
const TENANT_ROWS: MatrixRow[] = [
  { group: 'Organization', key: 'settings.view', label: 'Open organization settings', hint: 'Needed for the items below that live there' },
  { group: 'Organization', key: 'settings.edit', label: 'Edit organization settings' },
  { group: 'Organization', key: 'members.manage', label: 'Manage members', hint: 'Invite, suspend and remove. Can’t make anyone an Admin.' },
  { group: 'Organization', key: 'audit.view', label: 'View the organization audit log' },
  { group: 'Workspaces and projects', key: 'workspace.create', label: 'Create workspaces' },
  { group: 'Workspaces and projects', key: 'workspace.edit', label: 'Rename and archive workspaces' },
  { group: 'Workspaces and projects', key: 'project.create', label: 'Create projects', hint: 'The creator becomes its Project Admin' },
  { group: 'Workspaces and projects', key: 'project.list_all', label: 'See every project’s name', hint: 'Content still needs a project membership' },
  { group: 'Ownership', key: 'transfer', label: 'Transfer ownership', fullOnly: OWNER_ONLY },
  { group: 'Ownership', key: 'roles', label: 'Change this permissions table', fullOnly: OWNER_ONLY },
];

function Legend() {
  return (
    <div className="rm-legend" aria-hidden="true">
      <span><Check size={14} className="pin" /> Allowed</span>
      <span><Minus size={14} /> Not allowed</span>
      <span><Lock size={12} /> Fixed — hover for the reason</span>
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
    <div className="save-bar" role="region" aria-label="Unsaved permission changes">
      <span className="muted">Unsaved changes</span>
      <span className="spacer" />
      <button className="btn" onClick={onDiscard} disabled={busy}>Discard</button>
      <button className="btn primary" onClick={onSave} disabled={busy}>{busy ? <Spinner /> : 'Save permissions'}</button>
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
      toast('Permissions saved — they apply on everyone’s next action');
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
        caption="Project roles and what each can do"
        highlight={myRole}
        readOnly={!editable}
        columns={[
          { key: 'project_admin', label: 'Project Admin', header: <RoleBadge role="project_admin" />, full: true },
          { key: 'maintainer', label: 'Maintainer', header: <RoleBadge role="maintainer" /> },
          { key: 'member', label: 'Member', header: <RoleBadge role="member" /> },
          { key: 'viewer', label: 'Viewer', header: <RoleBadge role="viewer" /> },
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
      toast('Permissions saved — they apply on everyone’s next action');
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
        caption="Organization roles and what each can do"
        highlight={myRole}
        readOnly={!editable}
        columns={[
          { key: 'owner', label: 'Owner', header: <TenantRoleBadge role="owner" />, full: true },
          { key: 'admin', label: 'Admin', header: <TenantRoleBadge role="admin" /> },
          { key: 'member', label: 'Member', header: <TenantRoleBadge role="member" /> },
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
