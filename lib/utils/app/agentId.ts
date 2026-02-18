/**
 * Agent ID validation utilities
 *
 * Supports two formats:
 * - Legacy: asst_xxxxx (Azure AI Assistants API)
 * - New: agent-name (Azure AI Foundry Agent Service)
 */

const LEGACY_AGENT_ID_PATTERN = /^asst_[A-Za-z0-9_-]+$/;
const NEW_AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Check if a string is a valid legacy agent ID (asst_xxxxx format)
 */
export function isLegacyAgentId(id: string): boolean {
  return LEGACY_AGENT_ID_PATTERN.test(id);
}

/**
 * Check if a string is a valid agent ID in either legacy or new format.
 * - Legacy: asst_xxxxx
 * - New: alphanumeric name with hyphens/underscores (no asst_ prefix)
 */
export function isValidAgentId(id: string): boolean {
  return LEGACY_AGENT_ID_PATTERN.test(id) || NEW_AGENT_NAME_PATTERN.test(id);
}
