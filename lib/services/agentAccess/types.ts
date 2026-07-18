/**
 * App-layer agent access control — schemas, canonical keys, blob paths.
 *
 * See docs/AGENT_ACCESS_CONTROL.md. Rules only ever further restrict what a
 * user's own Azure RBAC already allows; they can never grant access Azure
 * denies. All blobs live under a reserved `system/` prefix that cannot
 * collide with user upload paths (`<userId-guid>/uploads/...`).
 */
import Hasher from '@/lib/utils/app/hash';

import { z } from 'zod';

export const AGENT_ACCESS_PREFIX = 'system/agent-access/';
export const AGENT_ACCESS_RULES_PREFIX = `${AGENT_ACCESS_PREFIX}rules/`;
export const AGENT_ACCESS_HISTORY_PREFIX = `${AGENT_ACCESS_PREFIX}history/`;
export const AGENT_ACCESS_CONFIG_PATH = `${AGENT_ACCESS_PREFIX}config.json`;

export const AgentAccessTypeSchema = z.enum(['public', 'restricted']);
export type AgentAccessType = z.infer<typeof AgentAccessTypeSchema>;

export const AgentAccessRuleSchema = z.object({
  version: z.literal(1),
  /** Original casing preserved for display; matching uses canonicalAgentKey. */
  source: z.string().min(1),
  agentName: z.string().min(1),
  access: z.object({
    type: AgentAccessTypeSchema,
    /** Matched against the part after '@' in session.user.mail (lowercased). */
    allowDomains: z.array(z.string()).default([]),
    /** Matched lowercased against session.user.mail. */
    allowUsers: z.array(z.string()).default([]),
    /** SCAFFOLD ONLY — persisted but never evaluated in v1 (pending tenant consent). */
    allowGroups: z.array(z.string()).default([]),
  }),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type AgentAccessRule = z.infer<typeof AgentAccessRuleSchema>;

export const LocalAdminEntrySchema = z.object({
  /** Graph `mail` value; matched lowercased + trimmed. */
  email: z.string().min(1),
  /** Canonical agent keys this local admin may create/edit/delete rules for. */
  agentKeys: z.array(z.string()).default([]),
});
export type LocalAdminEntry = z.infer<typeof LocalAdminEntrySchema>;

export const AgentAccessConfigSchema = z.object({
  version: z.literal(1),
  localAdmins: z.array(LocalAdminEntrySchema).default([]),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type AgentAccessConfig = z.infer<typeof AgentAccessConfigSchema>;

/**
 * Immutable audit copy written alongside every successful rule write
 * (including deletes, which record a null-rule tombstone).
 */
export const AgentAccessHistoryEntrySchema = z.object({
  version: z.literal(1),
  canonicalKey: z.string().min(1),
  action: z.enum(['upsert', 'delete']),
  /** The full rule as written, or null for a delete tombstone. */
  rule: AgentAccessRuleSchema.nullable(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type AgentAccessHistoryEntry = z.infer<
  typeof AgentAccessHistoryEntrySchema
>;

/**
 * ARM resource paths are case-insensitive to Azure but compared as raw
 * strings elsewhere in the app — rule matching MUST canonicalize both halves
 * (lowercase + trim) to prevent case-variant bypass.
 */
export function canonicalAgentKey(source: string, agentName: string): string {
  return `${source.trim().toLowerCase()}::${agentName.trim().toLowerCase()}`;
}

/** `system/agent-access/rules/<sha256(canonicalKey)>.json` */
export function ruleBlobPath(canonicalKey: string): string {
  return `${AGENT_ACCESS_RULES_PREFIX}${Hasher.sha256(canonicalKey)}.json`;
}

/** `system/agent-access/history/<sha256(canonicalKey)>/<iso-ts>.json` */
export function historyBlobPath(
  canonicalKey: string,
  isoTimestamp: string,
): string {
  return `${AGENT_ACCESS_HISTORY_PREFIX}${Hasher.sha256(canonicalKey)}/${isoTimestamp}.json`;
}
