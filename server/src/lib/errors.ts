export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'CSRF_FAILED'
  | 'READ_ONLY'
  | 'INVITATION_INVALID'
  | 'FILE_NOT_AVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
export const forbidden = (msg = 'You do not have permission to perform this action.') =>
  new AppError(403, 'FORBIDDEN', msg);
/** Used both for absent and for concealed resources — never reveals existence (§9). */
export const notFound = (what = 'resource') => new AppError(404, 'NOT_FOUND', `The requested ${what} was not found.`);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'CONFLICT', msg, details);
export const invalid = (msg: string, details?: unknown) => new AppError(422, 'VALIDATION_ERROR', msg, details);
export const readOnly = () =>
  new AppError(409, 'READ_ONLY', 'This project is archived or paused, so changes are not allowed.');
