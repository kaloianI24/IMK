// site/shared/portal-store/errors.ts
//
// Storage failures must be loud: a handler that cannot reach the store must
// answer 503, never "here is an empty list" (proposal §2.2 contract rules,
// task T9). Every adapter therefore throws StorageError instead of degrading.

export type StorageErrorCode =
  | 'storage-unavailable'
  | 'storage-corrupt'
  | 'invalid-operation'
  | 'invalid-config'
  | 'not-implemented';

export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(message: string, code: StorageErrorCode = 'storage-unavailable', cause?: unknown) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
