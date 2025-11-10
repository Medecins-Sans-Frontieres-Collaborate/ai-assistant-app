/**
 * Client-side services.
 *
 * Organized by domain:
 * - API: Centralized HTTP client and types
 * - Chat: Chat completion services
 *
 * Usage:
 * ```ts
 * import { chatService, apiClient, ApiError } from '@/client/services';
 *
 * const stream = await chatService.chat(model, messages, options);
 * ```
 */

// API client and types
export * from './api';

// Chat services
export * from './chat';
