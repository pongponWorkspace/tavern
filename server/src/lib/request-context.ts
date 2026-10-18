import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProjectRole } from '../authz/policy.js';

/** Per-request values that deep helpers (like loadProjectAccess) need without threading them through every call. */
export interface RequestContext {
  method: string;
  /** "View as" preview requested by a Project Admin (x-preview-role header). */
  previewRole?: Exclude<ProjectRole, 'project_admin'>;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
export const currentRequest = () => requestContext.getStore();
