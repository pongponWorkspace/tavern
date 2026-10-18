import type { ProjectRole, TenantRole } from '../api';

export const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  project_admin: 'Project Admin',
  maintainer: 'Maintainer',
  member: 'Member',
  viewer: 'Viewer',
};
export const PROJECT_ROLE_HINT: Record<ProjectRole, string> = {
  project_admin: 'Manages settings, members, invitations and all knowledge',
  maintainer: 'Maintains knowledge and onboarding; cannot manage members',
  member: 'Reads knowledge and contributes where the project allows',
  viewer: 'Read-only access',
};
export const TENANT_ROLE_LABEL: Record<TenantRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
export const TYPE_LABEL = { external_link: 'Link', uploaded_file: 'File', internal_document: 'Document' } as const;

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: abs > 86400 * 300 ? 'numeric' : undefined });
}
export const fullDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

export function bytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const AVATAR_COLORS = [1, 2, 3, 4, 5, 6].map((n) => `var(--color-avatar-${n})`);
export function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

const ACTION_LABEL: Record<string, string> = {
  'knowledge.created': 'added', 'knowledge.updated': 'edited', 'knowledge.content_updated': 'edited the document',
  'knowledge.archived': 'archived', 'knowledge.restored': 'restored', 'knowledge.deleted': 'permanently deleted',
  'knowledge.pinned': 'pinned', 'knowledge.unpinned': 'unpinned', 'knowledge.access_changed': 'changed who can access',
  'project.created': 'created the project', 'project.updated': 'updated project details', 'project.permissions_changed': 'changed role permissions', 'project.policy_changed': 'changed contribution rules',
  'project.archived': 'archived the project', 'project.restored': 'restored the project',
  'project.member_added': 'added', 'project.member_removed': 'removed', 'project.member_role_changed': 'changed the role of',
  'invitation.created': 'created an invitation', 'invitation.revoked': 'revoked an invitation', 'invitation.accepted': 'accepted an invitation',
  'invitation.accept': 'tried to use an invitation',
  'category.created': 'created category', 'category.updated': 'updated category', 'category.deleted': 'deleted category',
  'file.uploaded': 'uploaded a file', 'file.deleted': 'deleted a file', 'file.scan_clean': 'File passed the security scan',
  'file.scan_quarantined': 'File was quarantined by the security scan', 'file.scan_failed': 'File could not be scanned',
  'onboarding.template_created': 'created a checklist', 'onboarding.template_updated': 'updated a checklist',
  'onboarding.step_created': 'added a checklist step', 'onboarding.step_updated': 'edited a checklist step', 'onboarding.step_deleted': 'removed a checklist step',
  'tenant.created': 'created the organization', 'tenant.permissions_changed': 'changed role permissions', 'tenant.settings_updated': 'updated organization settings',
  'tenant.member_added': 'joined', 'tenant.member_removed': 'removed', 'tenant.member_role_changed': 'changed the role of',
  'tenant.member_suspended': 'suspended', 'tenant.member_reactivated': 'reactivated', 'tenant.ownership_transferred': 'transferred ownership to',
  'workspace.created': 'created workspace', 'workspace.updated': 'updated workspace', 'workspace.archived': 'archived workspace', 'workspace.restored': 'restored workspace',
};
export const actionLabel = (a: string) => ACTION_LABEL[a] ?? a.replace(/[._]/g, ' ');
