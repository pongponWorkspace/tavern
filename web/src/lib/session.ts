import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrf, type Me } from '../api';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await api<Me>('/me');
        setCsrf(me.csrfToken);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setCsrf(null);
    qc.clear();
    window.location.assign('/login');
  };
}

const KEY = 'tavern.lastTenant';
export const rememberTenant = (id: string) => {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable — fine */
  }
};
export const lastTenant = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

const THEME = 'tavern.theme';
export function applyStoredTheme() {
  try {
    const entry = localStorage.getItem(THEME);
    if (entry === 'light' || entry === 'dark') document.documentElement.dataset.theme = entry;
  } catch {
    /* ignore */
  }
}
export function cycleTheme(): 'light' | 'dark' | 'system' {
  const cur = document.documentElement.dataset.theme;
  const next = cur === 'light' ? 'dark' : cur === 'dark' ? 'system' : 'light';
  if (next === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try {
    if (next === 'system') localStorage.removeItem(THEME);
    else localStorage.setItem(THEME, next);
  } catch {
    /* ignore */
  }
  return next;
}

export interface TenantPerms {
  manageSettings: boolean; editSettings: boolean; manageMembers: boolean; createWorkspace: boolean; editWorkspace: boolean;
  createProject: boolean; listAllProjects: boolean; viewAudit: boolean; transferOwnership: boolean; manageRoles: boolean;
}
const NO_PERMS: TenantPerms = {
  manageSettings: false, editSettings: false, manageMembers: false, createWorkspace: false, editWorkspace: false,
  createProject: false, listAllProjects: false, viewAudit: false, transferOwnership: false, manageRoles: false,
};

/** What the signed-in person may do in this organization, per its (customizable) role table. */
export function useTenantPerms(tenantId: string | null | undefined): TenantPerms {
  const q = useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => api<{ permissions: TenantPerms }>(`/tenants/${tenantId}`),
    enabled: Boolean(tenantId),
    staleTime: 30_000,
  });
  return q.data?.permissions ?? NO_PERMS;
}
