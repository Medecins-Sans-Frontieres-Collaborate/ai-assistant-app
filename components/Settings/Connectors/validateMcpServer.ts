import { McpServerRequestEntry, McpToolSummary } from '@/types/mcp';

export interface McpValidationResult {
  ok: boolean;
  toolCount: number;
  tools: McpToolSummary[];
  /** 'auth' → wrong/missing token; 'unreachable' → everything else. */
  errorKind?: 'auth' | 'unreachable';
}

/**
 * Form-time validation against POST /api/mcp/tools (runs on unsaved input,
 * so it's a plain fetch rather than a React Query hook). The token travels
 * in the body only.
 */
export async function validateMcpServer(
  server: McpServerRequestEntry,
): Promise<McpValidationResult> {
  try {
    const response = await fetch('/api/mcp/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server, refresh: true }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        toolCount: 0,
        tools: [],
        errorKind: json?.code === 'MCP_AUTH_FAILED' ? 'auth' : 'unreachable',
      };
    }
    const tools: McpToolSummary[] = json?.data?.tools ?? [];
    return { ok: true, toolCount: tools.length, tools };
  } catch {
    return { ok: false, toolCount: 0, tools: [], errorKind: 'unreachable' };
  }
}
