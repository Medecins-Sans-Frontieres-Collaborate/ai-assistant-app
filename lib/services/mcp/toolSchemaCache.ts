import { createHash } from 'node:crypto';

/**
 * In-memory MCP tool-schema cache so a consent resume round (same user, same
 * servers, seconds later) skips re-listing tools. Single-replica only — the
 * accepted pattern in this codebase (see chunked transcription jobs); a miss
 * just costs one listTools round-trip.
 *
 * Keys include a hash of the auth token (never the raw token) so a rotated
 * token can't serve a stale, differently-authorized tool list.
 */

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** One server's cached listing: its tools plus initialize `instructions`. */
export interface McpServerListing {
  tools: McpToolDefinition[];
  /** Server-declared usage guidance from the initialize handshake. */
  instructions?: string;
}

interface CacheEntry extends McpServerListing {
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;

const cache = new Map<string, CacheEntry>();

export function toolCacheKey(
  userId: string,
  url: string,
  authToken?: string,
): string {
  const tokenHash = authToken
    ? createHash('sha256').update(authToken).digest('hex').slice(0, 16)
    : 'anon';
  return `${userId}|${url}|${tokenHash}`;
}

export function getCachedTools(key: string): McpServerListing | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return { tools: entry.tools, instructions: entry.instructions };
}

export function setCachedTools(key: string, listing: McpServerListing): void {
  // Sweep expired entries opportunistically; hard-cap total size.
  if (cache.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.expiresAt < now) cache.delete(k);
    }
    if (cache.size >= MAX_ENTRIES) {
      // Evict oldest-inserted (Map preserves insertion order).
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
  }
  cache.set(key, { ...listing, expiresAt: Date.now() + TTL_MS });
}

/** Test hook. */
export function clearToolSchemaCache(): void {
  cache.clear();
}
