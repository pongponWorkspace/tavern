// Thin typed client for /api/v1. The CSRF token comes from /me (or the login
// response) and is attached to every mutating request.

export type ProjectRole = 'project_admin' | 'maintainer' | 'member' | 'viewer';
export type TenantRole = 'owner' | 'admin' | 'member';
export type ItemType = 'external_link' | 'uploaded_file' | 'internal_document';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

let csrfToken: string | null = null;

/** "View as" preview for Project Admins. The server applies it to reads and refuses changes while it's on. */
let previewRole: Exclude<ProjectRole, 'project_admin'> | null = null;
export const setPreviewRole = (r: typeof previewRole) => {
  previewRole = r;
};
export const setCsrf = (entry: string | null) => {
  csrfToken = entry;
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  let url = `/api/v1${path}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  if (previewRole) headers['x-preview-role'] = previewRole;
  let res: Response;
  try {
    res = await fetch(url, { method, headers, credentials: 'same-origin', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? 'Something went wrong.', e.details);
  }
  return data as T;
}

/** Upload a file through the signed-URL flow; resolves with the file id once the upload is finalized. */
export async function uploadFile(projectId: string, file: File, onProgress?: (pct: number) => void): Promise<string> {
  const init = await api<{ fileId: string; upload: { url: string; method: string; headers: Record<string, string> } }>(
    `/projects/${projectId}/files/upload-init`,
    { body: { filename: file.name, size: file.size, mimeType: file.type || 'application/octet-stream' } },
  );
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.upload.method, init.upload.url);
    for (const [k, v] of Object.entries(init.upload.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = 'Upload failed.';
      try {
        msg = JSON.parse(xhr.responseText).error.message;
      } catch {
        /* keep default */
      }
      reject(new ApiError(xhr.status, 'UPLOAD_FAILED', msg));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'The upload was interrupted.'));
    xhr.send(file);
  });
  await api(`/files/${init.fileId}/upload-complete`, { method: 'POST', body: {} });
  return init.fileId;
}

// ───────────────────────── Response types ─────────────────────────

export interface Me {
  user: { id: string; email: string; displayName: string; avatarUrl: string | null; emailVerified: boolean; hasPassword: boolean; googleLinked: boolean };
  csrfToken: string;
  tenants: { id: string; name: string; slug: string; role: TenantRole }[];
}

export interface Person {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
}

export interface ItemSummary {
  id: string;
  projectId: string;
  type: ItemType;
  title: string;
  description: string;
  externalUrl: string | null;
  isPinned: boolean;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  category: { id: string; name: string } | null;
  owner: Person | null;
  tags: string[];
  file: { id?: string; name: string; size: number; mimeType: string | null; scanStatus: 'pending' | 'clean' | 'quarantined' | 'failed' } | null;
  permissions?: { edit: boolean; archive: boolean; pin: boolean; delete: boolean; restrict?: boolean };
  project?: { id: string; name: string };
}

export interface ItemDetail extends ItemSummary {
  version: number;
  archivedAt: string | null;
  project: { id: string; name: string };
  createdBy: Person;
  updatedBy: Person;
  permissions: { edit: boolean; archive: boolean; pin: boolean; delete: boolean; restrict: boolean };
  access?: { visibilityRoles: ProjectRole[]; editRoles: ProjectRole[]; archiveRoles: ProjectRole[]; restricted: boolean };
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  contact: string;
  status: 'active' | 'archived';
  version: number;
  writable: boolean;
  tenant: { id: string; name: string };
  workspace: { id: string; name: string; status: string };
  owner: Person | null;
  myRole: ProjectRole;
  actualRole: ProjectRole;
  previewing: boolean;
  rolePermissions: import('./lib/rbac').ProjectPermissions;
  permissions: Record<string, boolean>;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  itemCount: number;
  description?: string;
  sortOrder?: number;
}
