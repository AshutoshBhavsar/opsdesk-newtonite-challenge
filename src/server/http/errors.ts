// One error type for everything the API deliberately rejects. Anything else is a bug (HTTP 500).

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthenticated = (message = 'Please sign in.') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do that.', code = 'FORBIDDEN') => new AppError(403, code, message);
/** Used for both "does not exist" and "exists but you cannot see it" so existence is never leaked. */
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details);
