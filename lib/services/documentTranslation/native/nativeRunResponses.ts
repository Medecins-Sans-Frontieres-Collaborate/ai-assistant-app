import { NextResponse } from 'next/server';

import { M365Error, m365ErrorResponse } from '@/lib/services/m365/graphApi';

import { errorResponse } from '@/lib/utils/server/api/apiResponse';
import { RunFileIntegrityError } from '@/lib/utils/shared/translation/nativeRunStorage';

import {
  NativeRunFileMissingError,
  NativeRunLockedError,
} from './nativePdfStorage';

/**
 * Error codes of the run-storage failures a browser acts on:
 *  - `RUN_FILES_MISSING` (404): the run expired or was deleted.
 *  - `RUN_LOCKED` (400): the run is encrypted and no key was sent.
 *  - `RUN_KEY_MISMATCH` (400): the key sent is not the run's.
 */
export const RUN_ERROR_CODES = {
  missing: 'RUN_FILES_MISSING',
  locked: 'RUN_LOCKED',
  keyMismatch: 'RUN_KEY_MISMATCH',
} as const;

/**
 * The response for a failure to reach a run's files.
 *
 * @param error - What a NativeRunStore call threw.
 * @returns The response, or null when the error is not a storage failure
 *   this module knows, for the caller to handle as it would any other.
 */
export function runStorageErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof NativeRunFileMissingError) {
    return errorResponse(
      error.message,
      404,
      undefined,
      RUN_ERROR_CODES.missing,
    );
  }
  if (error instanceof NativeRunLockedError) {
    return errorResponse(error.message, 400, undefined, RUN_ERROR_CODES.locked);
  }
  if (error instanceof RunFileIntegrityError) {
    return errorResponse(
      error.message,
      400,
      undefined,
      RUN_ERROR_CODES.keyMismatch,
    );
  }
  if (error instanceof M365Error) return m365ErrorResponse(error);
  return null;
}
