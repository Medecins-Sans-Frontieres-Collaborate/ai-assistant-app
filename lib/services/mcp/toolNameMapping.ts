import { McpToolDefinition } from './toolSchemaCache';

import { ResolvedMcpServer } from '@/config/mcpCatalog';
import { createHash } from 'node:crypto';

/**
 * Maps MCP tool names to/from the flat function names the chat.completions
 * `tools` array requires (`^[a-zA-Z0-9_-]{1,64}$`). Format:
 * `{serverId}__{sanitizedToolName}`, hash-suffixed when sanitization could
 * collide or the name overflows 64 chars.
 */

const SEPARATOR = '__';
const MAX_NAME_LENGTH = 64;

function sanitize(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 6);
}

export function toModelToolName(serverId: string, toolName: string): string {
  const sanitized = sanitize(toolName);
  let name = `${serverId}${SEPARATOR}${sanitized}`;
  // Sanitization is lossy — suffix a hash of the ORIGINAL name whenever it
  // changed anything, so `a.b` and `a-b` can't collide after mapping.
  if (sanitized !== toolName) {
    name = `${name}_${shortHash(toolName)}`;
  }
  if (name.length > MAX_NAME_LENGTH) {
    const hash = shortHash(`${serverId}${SEPARATOR}${toolName}`);
    name = `${name.slice(0, MAX_NAME_LENGTH - hash.length - 1)}_${hash}`;
  }
  return name;
}

/**
 * Resolves a model-emitted function name back to its server + original MCP
 * tool name by re-deriving the mapping over the known tool lists (the
 * mapping is not reversible by parsing — hash suffixes see to that).
 */
export function fromModelToolName(
  modelToolName: string,
  serversWithTools: Array<{
    server: ResolvedMcpServer;
    tools: McpToolDefinition[];
  }>,
): { server: ResolvedMcpServer; toolName: string } | null {
  for (const { server, tools } of serversWithTools) {
    for (const tool of tools) {
      if (toModelToolName(server.id, tool.name) === modelToolName) {
        return { server, toolName: tool.name };
      }
    }
  }
  return null;
}

/** OpenAI chat.completions tool declaration for one server's MCP tools. */
export function mcpToolsToOpenAITools(
  serverId: string,
  tools: McpToolDefinition[],
): Array<{
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: toModelToolName(serverId, tool.name),
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.inputSchema,
    },
  }));
}
