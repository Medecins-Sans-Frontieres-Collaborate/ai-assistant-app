import { NextResponse } from 'next/server';

/**
 * Standard API response utilities
 * Provides consistent response formats across all API routes
 */

export interface ApiErrorResponse {
  error: string;
  details?: string;
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
 * @param details - Additional error details
 * @param code - Error code for client-side handling
 * @returns NextResponse with standardized error format
 *
 * @example
 * return errorResponse('User not found', 404);
 * return errorResponse(new Error('Invalid input'), 400, 'Field "email" is required');
 */
export function errorResponse(
  error: string | Error,
  status: number = 500,
  details?: string,
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
  console.error('API Error:', error);

  if (error instanceof Error) {
    const status = (error as any).status || (error as any).statusCode || 500;
    return errorResponse(error.message, status);
  }

  return errorResponse(defaultMessage, 500);
}
