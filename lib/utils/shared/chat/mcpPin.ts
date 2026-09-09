/**
 * Applies a conversation's pinned-connector focus to the MCP servers being
 * sent with a chat turn: a valid pin narrows the list to JUST that server,
 * so only its tools are declared to the model.
 *
 * A pin that no longer matches (server deleted, disabled, filtered out by a
 * flag) is IGNORED — the full list goes through. Failing open here is
 * deliberate: the pin is a focus hint the user set at some point, and a
 * stale one must not silently strip every tool from the chat. The tray UI
 * is responsible for surfacing a stale pin, not this filter.
 */
export function applyMcpPin<T extends { id: string }>(
  candidates: T[],
  pinnedServerId: string | undefined,
): T[] {
  if (!pinnedServerId) return candidates;
  const pinned = candidates.filter((s) => s.id === pinnedServerId);
  return pinned.length > 0 ? pinned : candidates;
}
