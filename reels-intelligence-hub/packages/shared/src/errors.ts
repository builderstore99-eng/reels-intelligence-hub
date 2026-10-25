/**
 * Stable error codes.
 *
 * Every API error response carries one of these codes so the frontend can
 * branch on it without parsing human-readable text. Never rename an existing
 * code without a migration note — clients depend on the string value.
 */
export const ERROR_CODES = {
  // 400
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNSUPPORTED_SOURCE: 'UNSUPPORTED_SOURCE',
  INVALID_STATE: 'INVALID_STATE',
  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  // 403
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  // 404
  NOT_FOUND: 'NOT_FOUND',
  // 409
  CONFLICT: 'CONFLICT',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  // 402 / 403 provider-side
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  AUTHORIZATION_EXPIRED: 'AUTHORIZATION_EXPIRED',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  // 5xx
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  STORAGE_ERROR: 'STORAGE_ERROR',
  QUEUE_ERROR: 'QUEUE_ERROR',
  VECTOR_ERROR: 'VECTOR_ERROR',
  TIMEOUT: 'TIMEOUT',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Which codes are safe to retry. Anything not listed is a permanent failure —
 * the job pipeline uses this to decide between "schedule a retry" and
 * "dead-letter with a clear message".
 */
const RETRYABLE: ReadonlySet<string> = new Set<string>([
  ERROR_CODES.RATE_LIMITED,
  ERROR_CODES.PROVIDER_UNAVAILABLE,
  ERROR_CODES.DATABASE_ERROR,
  ERROR_CODES.STORAGE_ERROR,
  ERROR_CODES.QUEUE_ERROR,
  ERROR_CODES.VECTOR_ERROR,
  ERROR_CODES.TIMEOUT,
  ERROR_CODES.INTERNAL_ERROR,
]);

export function isRetryableCode(code: string): boolean {
  return RETRYABLE.has(code);
}

/** Default HTTP status for each code. */
export function statusForCode(code: ErrorCode): number {
  switch (code) {
    case ERROR_CODES.VALIDATION_FAILED:
    case ERROR_CODES.UNSUPPORTED_SOURCE:
    case ERROR_CODES.INVALID_STATE:
      return 400;
    case ERROR_CODES.UNAUTHENTICATED:
    case ERROR_CODES.INVALID_CREDENTIALS:
    case ERROR_CODES.SESSION_EXPIRED:
      return 401;
    case ERROR_CODES.FORBIDDEN:
    case ERROR_CODES.INSUFFICIENT_PERMISSIONS:
    case ERROR_CODES.PROVIDER_NOT_CONFIGURED:
      return 403;
    case ERROR_CODES.NOT_FOUND:
      return 404;
    case ERROR_CODES.CONFLICT:
    case ERROR_CODES.DUPLICATE_RESOURCE:
      return 409;
    case ERROR_CODES.RATE_LIMITED:
      return 429;
    case ERROR_CODES.TIMEOUT:
      return 504;
    default:
      return 500;
  }
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    requestId: string;
    /** Optional field-level detail from schema validation. */
    details?: unknown;
  };
}

/**
 * An error that is safe to render to the user. Anything thrown that is *not*
 * an AppError is treated as an internal failure: the message is replaced with
 * a generic one and the original is written to the server log only.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options?: { details?: unknown; status?: number }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = options?.status ?? statusForCode(code);
    this.details = options?.details;
    this.retryable = isRetryableCode(code);
  }

  toBody(requestId: string): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        requestId,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}
