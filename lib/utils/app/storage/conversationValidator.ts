/**
 * Conversation Validator
 *
 * Provides validation functions for conversation and folder data.
 * Used during storage hydration to detect and quarantine corrupted data.
 */
import { Conversation, ConversationEntry } from '@/types/chat';
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

  // Sanitize message entries — strip invalid ones to prevent runtime crashes
  if (Array.isArray(obj.messages)) {
    const sanitized = sanitizeMessages(obj.messages);
    (obj as Record<string, unknown>).messages = sanitized;
  }

  return { valid: true, data: data as Conversation, errors: [] };
}

/**
 * Validate a single message entry (Message or AssistantMessageGroup).
 * Returns true if the entry is structurally valid enough to keep.
 */
export function isValidMessageEntry(
  entry: unknown,
): entry is ConversationEntry {
  if (!entry || typeof entry !== 'object') return false;

  const obj = entry as Record<string, unknown>;

  // Check if it's an AssistantMessageGroup
  if (obj.type === 'assistant_group') {
    return (
      Array.isArray(obj.versions) &&
      obj.versions.length > 0 &&
      typeof obj.activeIndex === 'number' &&
      obj.activeIndex >= 0 &&
      obj.activeIndex < obj.versions.length
    );
  }

  // Check if it's a Message — must have role and content
  if (typeof obj.role === 'string' && obj.content !== undefined) {
    return true;
  }

  return false;
}

/**
 * Filter a messages array to only include structurally valid entries.
 * Invalid entries are silently stripped to prevent runtime crashes.
 */
export function sanitizeMessages(messages: unknown[]): ConversationEntry[] {
  return messages.filter(isValidMessageEntry);
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
