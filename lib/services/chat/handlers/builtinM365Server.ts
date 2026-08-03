/**
 * Pure helpers for the synthetic `builtin-m365` server seam (fourth pass
 * B1). The client requests the builtin M365 toolset with a marker entry
 * (`{ id: 'builtin-m365', builtin: true }`); the server partitions that
 * marker OUT before resolveMcpServers (it must never reach the custom-URL
 * branch) and constructs the ResolvedMcpServer itself — url-less, trusted,
 * `provenance: 'builtin'` — so a tampered entry can never carry routing.
 */
import {
  M365_BUILTIN_SERVER_ID,
  M365_BUILTIN_SERVER_LABEL,
} from '@/lib/services/m365/tools/toolCatalog';

import { McpServerRequestEntry } from '@/types/mcp';

import { ResolvedMcpServer } from '@/config/mcpCatalog';

export interface BuiltinMcpPartition {
  /** True when the client sent the well-known builtin-m365 marker entry. */
  builtinRequested: boolean;
  /** All non-builtin entries, for normal resolveMcpServers resolution. */
  rest: McpServerRequestEntry[];
}

/**
 * Splits client-sent MCP entries into the builtin M365 marker and the rest.
 * `builtin: true` entries with any OTHER id are dropped entirely — there is
 * exactly one builtin toolset, and an unknown builtin id must not fall
 * through to network resolution.
 */
export function partitionBuiltinMcpEntries(
  entries: McpServerRequestEntry[] | undefined,
): BuiltinMcpPartition {
  const rest: McpServerRequestEntry[] = [];
  let builtinRequested = false;
  for (const entry of entries ?? []) {
    if (entry.builtin) {
      if (entry.id === M365_BUILTIN_SERVER_ID) builtinRequested = true;
      continue;
    }
    rest.push(entry);
  }
  return { builtinRequested, rest };
}

/** The synthetic ResolvedMcpServer the tool loop dispatches in-process. */
export function buildBuiltinM365Server(): ResolvedMcpServer {
  return {
    id: M365_BUILTIN_SERVER_ID,
    label: M365_BUILTIN_SERVER_LABEL,
    url: '',
    transport: 'streamable-http',
    auth: { style: 'none' },
    trusted: true,
    provenance: 'builtin',
  };
}
