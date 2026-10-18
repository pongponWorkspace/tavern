import { z, type ZodTypeAny } from 'zod';
import { invalid } from './errors.js';

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw invalid(fields[0] ? `${fields[0].path || 'request'}: ${fields[0].message}` : 'Invalid request.', { fields });
  }
  return result.data;
}

export const uuid = z.string().uuid();
export const projectRole = z.enum(['project_admin', 'maintainer', 'member', 'viewer']);
export const limitParam = z.coerce.number().int().min(1).max(100).default(20);
