/**
 * Centralized API client and types.
 *
 * Provides:
 * - ApiClient: Centralized HTTP client with interceptors
 * - ApiError: Custom error class for API errors
 * - API request/response types
 *
 * Usage:
 * ```ts
 * import { apiClient, ApiError } from '@/client/services/api';
 *
 * try {
 *   const response = await apiClient.post('/api/chat', requestData);
 * } catch (error) {
 *   if (error instanceof ApiError) {
 *     console.error('API error:', error.getUserMessage());
 *   }
 * }
 * ```
 */

export { ApiClient, apiClient } from './client';
export { ApiError } from './errors';
export * from './types';
