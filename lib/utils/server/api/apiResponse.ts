import { NextResponse } from 'next/server';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

/**
 * Standard API response utilities
 * Provides consistent response formats across all API routes
 */

/**
 * Machine-readable error detail. A plain string is the common case; a route
 * whose refusal names several things at once (e.g. `LIMITS_OUT_OF_SCOPE`
 * → `{ outOfScope: string[] }`) sends a JSON object so the client never has
 * to re-parse a serialized string. Consumers narrow with `typeof`.
 */
export type ApiErrorDetails = string | Record<string, unknown>;

export interface ApiErrorResponse {
  error: string;
  details?: ApiErrorDetails;
  code?: string;
}

export interface ApiSuccessResponse<T = any> {
  success: true;
  data?: T;
  message?: string;
}

/**
 * Creates a standardized error response
 *
 * @param error - Error message or Error object
 * @param status - HTTP status code (default: 500)
 * @param details - Additional error details: a string, or a JSON object when
 *   the client needs structure (see {@link ApiErrorDetails})
 * @param code - Error code for client-side handling
 * @returns NextResponse with standardized error format
 *
 * @example
 * return errorResponse('User not found', 404);
 * return errorResponse(new Error('Invalid input'), 400, 'Field "email" is required');
 * return errorResponse('Targets refused', 400, { outOfScope: ['a@b.org'] }, 'LIMITS_OUT_OF_SCOPE');
 */
export function errorResponse(
  error: string | Error,
  status: number = 500,
  details?: ApiErrorDetails,
  code?: string,
): NextResponse<ApiErrorResponse> {
  const errorMessage = error instanceof Error ? error.message : error;

  const response: ApiErrorResponse = {
    error: errorMessage,
    ...(details && { details }),
    ...(code && { code }),
  };

  return NextResponse.json(response, { status });
}

/**
 * Creates a standardized success response
 *
 * @param data - Response data
 * @param message - Optional success message
 * @param status - HTTP status code (default: 200)
 * @returns NextResponse with standardized success format
 *
 * @example
 * return successResponse({ user: userData });
 * return successResponse(null, 'File uploaded successfully', 201);
 */
export function successResponse<T = any>(
  data?: T,
  message?: string,
  status: number = 200,
): NextResponse<ApiSuccessResponse<T>> {
  const response: ApiSuccessResponse<T> = {
    success: true,
    ...(data !== undefined && { data }),
    ...(message && { message }),
  };

  return NextResponse.json(response, { status });
}

/**
 * Creates an unauthorized (401) error response
 *
 * @param message - Custom error message (default: 'Unauthorized')
 * @param details - Additional details
 * @returns NextResponse with 401 status
 */
export function unauthorizedResponse(
  message: string = 'Unauthorized',
  details?: string,
): NextResponse<ApiErrorResponse> {
  return errorResponse(message, 401, details, 'UNAUTHORIZED');
}

/**
 * Creates a bad request (400) error response
 *
 * @param message - Error message
 * @param details - Additional details about what's invalid
 * @returns NextResponse with 400 status
 */
export function badRequestResponse(
  message: string,
  details?: string,
): NextResponse<ApiErrorResponse> {
  return errorResponse(message, 400, details, 'BAD_REQUEST');
}

/**
 * Creates a not found (404) error response
 *
 * @param resource - Resource type that wasn't found
 * @param details - Additional details
 * @returns NextResponse with 404 status
 */
export function notFoundResponse(
  resource: string,
  details?: string,
): NextResponse<ApiErrorResponse> {
  return errorResponse(`${resource} not found`, 404, details, 'NOT_FOUND');
}

/**
 * Creates a forbidden (403) error response
 *
 * @param message - Error message (default: 'Access denied')
 * @param details - Additional details
 * @returns NextResponse with 403 status
 */
export function forbiddenResponse(
  message: string = 'Access denied',
  details?: string,
): NextResponse<ApiErrorResponse> {
  return errorResponse(message, 403, details, 'FORBIDDEN');
}

/**
 * Creates a payload too large (413) error response
 *
 * @param maxSize - Maximum allowed size
 * @param details - Additional details
 * @returns NextResponse with 413 status
 */
export function payloadTooLargeResponse(
  maxSize: string,
  details?: string,
): NextResponse<ApiErrorResponse> {
  return errorResponse(
    `Payload exceeds maximum size of ${maxSize}`,
    413,
    details,
    'PAYLOAD_TOO_LARGE',
  );
}

/**
 * Handles API errors with proper status codes
 * Automatically determines status from error object if available
 *
 * @param error - Error to handle
 * @param defaultMessage - Fallback message if error doesn't have one
 * @returns NextResponse with appropriate error status
 *
 * @example
 * try {
 *   // ... API logic
 * } catch (error) {
 *   return handleApiError(error, 'Failed to process request');
 * }
 */
export function handleApiError(
  error: unknown,
  defaultMessage: string = 'An unexpected error occurred',
): NextResponse<ApiErrorResponse> {
  // Error messages often embed request-provided strings — collapse to one
  // line so they can't forge extra log entries (CWE-117).
  console.error('API Error:', sanitizeForLog(error));

  if (error instanceof Error) {
    // HTTP-error-shaped Errors carry status under `.status` or `.statusCode`
    // depending on the library; neither is part of the base Error type.
    const err = error as Error & { status?: number; statusCode?: number };
    const status = err.status || err.statusCode || 500;
    return errorResponse(error.message, status);
  }

  return errorResponse(defaultMessage, 500);
}
