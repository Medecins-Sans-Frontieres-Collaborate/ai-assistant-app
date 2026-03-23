/**
 * Conversation Validator
 *
 * Provides validation functions for conversation and folder data.
 * Used during storage hydration to detect and quarantine corrupted data.
 */
import { Conversation } from '@/types/chat';
import { FolderInterface } from '@/types/folder';

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  errors: string[];
}

/**
 * Safely parse a JSON string, returning structured error info on failure.
 */
export function tryParseJSON<T = unknown>(
  raw: string,
): { data?: T; error?: string } {
  try {
    const data = JSON.parse(raw) as T;
    return { data };
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : 'JSON parse failed',
    };
  }
}

/**
 * Validate that a parsed object is a structurally valid Conversation.
 * Checks required fields; tolerates extra/missing optional fields.
 */
export function validateConversation(
  data: unknown,
): ValidationResult<Conversation> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Not an object'] };
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    errors.push('Missing or invalid "id" (expected non-empty string)');
  }

  if (typeof obj.name !== 'string') {
    errors.push('Missing or invalid "name" (expected string)');
  }

  if (!Array.isArray(obj.messages)) {
    errors.push('Missing or invalid "messages" (expected array)');
  }

  if (
    !obj.model ||
    typeof obj.model !== 'object' ||
    typeof (obj.model as Record<string, unknown>).id !== 'string' ||
    typeof (obj.model as Record<string, unknown>).name !== 'string'
  ) {
    errors.push(
      'Missing or invalid "model" (expected object with id and name)',
    );
  }

  if (typeof obj.temperature !== 'number') {
    errors.push('Missing or invalid "temperature" (expected number)');
  }

  if (typeof obj.prompt !== 'string') {
    errors.push('Missing or invalid "prompt" (expected string)');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: data as Conversation, errors: [] };
}

/**
 * Validate that a parsed object is a structurally valid FolderInterface.
 */
export function validateFolder(
  data: unknown,
): ValidationResult<FolderInterface> {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Not an object'] };
  }

  const obj = data as Record<string, unknown>;

  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    errors.push('Missing or invalid "id" (expected non-empty string)');
  }

  if (typeof obj.name !== 'string') {
    errors.push('Missing or invalid "name" (expected string)');
  }

  if (typeof obj.type !== 'string') {
    errors.push('Missing or invalid "type" (expected string)');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: data as FolderInterface, errors: [] };
}
