'use client';

import { CompactMapFeature } from '@/lib/services/workflows/map/chatPrompts';

import {
  NamedConnection,
  resolveConnections,
} from '@/lib/utils/shared/geo/connections';
import { featureEventRange } from '@/lib/utils/shared/geo/eventTime';
import { isValidCoordinate } from '@/lib/utils/shared/geo/geojson';
import { MAP_MAX_FEATURES } from '@/lib/utils/shared/geo/mapLimits';

import {
  Conversation,
  Message,
  MessageType,
  isAssistantMessageGroup,
} from '@/types/chat';
import { MapFeature, MapWorkflowState } from '@/types/workflow';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { scanStreamEvents } from '@/lib/streamMarkers';
import { v4 as uuidv4 } from 'uuid';

const MAX_RAIL_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1_000;
const MAX_FEATURES = MAP_MAX_FEATURES;
const DESCRIPTION_CHARS = 160;

function entryToChatMessage(
  entry: Conversation['messages'][number],
): { role: 'user' | 'assistant'; content: string } | null {
  if (isAssistantMessageGroup(entry)) {
    const active = entry.versions[entry.activeIndex];
    const content = typeof active?.content === 'string' ? active.content : '';
    return content ? { role: 'assistant', content } : null;
  }
  if (entry.role !== 'user' && entry.role !== 'assistant') return null;
  const content = typeof entry.content === 'string' ? entry.content : '';
  return content ? { role: entry.role, content } : null;
}

function compactFeature(f: MapFeature): CompactMapFeature {
  // Legacy features still carry the old partial-date fields; the accessor
  // presents both shapes as one range.
  const range = featureEventRange(f);
  return {
    name: f.name,
    lat: f.lat,
    lon: f.lon,
    category: f.category,
    granularity: f.granularity ?? 'city',
    prominence: f.prominence ?? 'primary',
    confidence: f.confidence,
    countryCode: f.countryCode,
    eventStart: range?.start,
    eventEnd: range?.end ?? undefined,
    eventOngoing: range?.ongoing,
    eventPrecision: range?.precision,
    description: (f.description ?? '').slice(0, DESCRIPTION_CHARS),
  };
}

interface ChatMutations {
  features: Array<Omit<MapFeature, 'id' | 'sourceId'>>;
  connections: NamedConnection[];
}

/**
 * Applies chat-proposed mutations to the map state. Exported for tests.
 * Returns a summary for the notice line, or null when nothing applied.
 */
export function applyChatMutations(
  conversationId: string,
  mutations: ChatMutations,
): {
  added: number;
  connected: number;
  unresolved: number;
  capped: boolean;
} | null {
  const store = useConversationStore.getState();
  const conversation = store.conversations.find((c) => c.id === conversationId);
  const state =
    conversation?.workflowState?.kind === 'map'
      ? (conversation.workflowState as MapWorkflowState)
      : undefined;
  if (!state) return null;

  const validFeatures = mutations.features.filter((f) =>
    isValidCoordinate(f.lat, f.lon),
  );
  if (state.features.length + validFeatures.length > MAX_FEATURES) {
    return { added: 0, connected: 0, unresolved: 0, capped: true };
  }

  const sourceId = uuidv4();
  const incoming: MapFeature[] = validFeatures.map((f) => ({
    ...f,
    id: uuidv4(),
    sourceId,
  }));

  const { connections, unresolved } = resolveConnections(
    mutations.connections,
    [...incoming, ...state.features],
    uuidv4,
    sourceId,
  );

  if (incoming.length === 0 && connections.length === 0) {
    return unresolved > 0
      ? { added: 0, connected: 0, unresolved, capped: false }
      : null;
  }

  store.updateWorkflowState(conversationId, (prev) => {
    const p = prev as MapWorkflowState;
    return {
      ...p,
      features: [...p.features, ...incoming],
      connections: [...(p.connections ?? []), ...connections],
      sources:
        incoming.length > 0
          ? [
              ...p.sources,
              {
                id: sourceId,
                name: 'Chat',
                addedAt: new Date().toISOString(),
                featureCount: incoming.length,
                kind: 'chat' as const,
              },
            ]
          : p.sources,
      updatedAt: new Date().toISOString(),
    };
  });

  return {
    added: incoming.length,
    connected: connections.length,
    unresolved,
    capped: false,
  };
}

/**
 * Map-workflow override for the conversation rail's send path (wired via
 * the workflow registry's `railSend`). Streams a grounded answer from
 * /api/workflows/map/chat through the chatStore's streaming state — so
 * WorkflowRailMessages renders it exactly like a normal chat reply and
 * the rail's Stop button aborts it — then persists the exchange and
 * applies any map mutations the assistant committed to.
 */
export async function sendRailMessage(
  conversation: Conversation,
  text: string,
): Promise<void> {
  const conversationStore = useConversationStore.getState();
  const chatStore = useChatStore.getState();
  const state =
    conversation.workflowState?.kind === 'map'
      ? (conversation.workflowState as MapWorkflowState)
      : undefined;

  const userMessage: Message = {
    id: uuidv4(),
    role: 'user',
    content: text,
    messageType: MessageType.TEXT,
  };
  const messagesWithUser = [...conversation.messages, userMessage];
  conversationStore.updateConversation(conversation.id, {
    messages: messagesWithUser,
  });
  const conversationWithUser: Conversation = {
    ...conversation,
    messages: messagesWithUser,
  };

  chatStore.initializeStreamingState(conversation.id, 'chat.loading');
  const signal = useChatStore.getState().abortController?.signal;

  const railMessages = messagesWithUser
    .map(entryToChatMessage)
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .slice(-MAX_RAIL_MESSAGES)
    .map((m) => ({ ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));

  const featureById = new Map(
    (state?.features ?? []).map((f) => [f.id, f.name]),
  );
  const existingConnections = (state?.connections ?? []).flatMap((c) => {
    const fromName = featureById.get(c.fromId);
    const toName = featureById.get(c.toId);
    return fromName && toName ? [{ fromName, toName, kind: c.kind }] : [];
  });

  let displayText = '';
  let mutations: ChatMutations | null = null;
  let failed: string | null = null;

  try {
    const response = await fetch('/api/workflows/map/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: railMessages,
        features: (state?.features ?? []).map(compactFeature),
        connections: existingConnections,
        modelId: conversation.model?.id,
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      let message = `Request failed (${response.status})`;
      try {
        const parsed = await response.json();
        if (parsed?.error) message = String(parsed.error);
      } catch {
        // non-JSON body
      }
      throw new Error(message);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let processedIndex = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const scan = scanStreamEvents(buffered, processedIndex);
      processedIndex = scan.nextIndex;
      for (const event of scan.events) {
        if (event.type === 'workflow_event') {
          if (event.payload.type === 'chat_mutations') {
            mutations = event.payload.data as ChatMutations;
          } else if (event.payload.type === 'error') {
            failed =
              (event.payload.data as { message?: string })?.message ??
              'Map chat failed';
          }
        }
      }
      if (scan.displayDelta) {
        displayText += scan.displayDelta;
        useChatStore.getState().appendStreamingContent(scan.displayDelta);
      }
    }
  } catch (error) {
    if (!signal?.aborted) {
      failed = error instanceof Error ? error.message : 'Map chat failed';
    }
  }

  // Apply mutations first so the outcome can be reported inside the
  // assistant message. These summary lines are message content (like the
  // model's own reply), not UI chrome, so they aren't run through i18n.
  let suffix = '';
  if (mutations && !signal?.aborted) {
    const result = applyChatMutations(conversation.id, mutations);
    if (result?.capped) {
      suffix = `\n\n_Nothing was added: the map is limited to ${MAX_FEATURES} locations._`;
    } else if (result) {
      const parts: string[] = [];
      if (result.added > 0) parts.push(`${result.added} location(s)`);
      if (result.connected > 0) parts.push(`${result.connected} connection(s)`);
      if (parts.length > 0) {
        suffix = `\n\n_Added ${parts.join(' and ')} to the map._`;
      }
      if (result.unresolved > 0) {
        suffix += `\n_${result.unresolved} connection(s) referenced places that aren't on the map and were skipped._`;
      }
    }
  }

  // Persist whatever answer we have (partial on abort), mirroring the
  // generic pipeline's behavior.
  const finalText = (failed && !displayText ? failed : displayText) + suffix;
  if (finalText.trim()) {
    const assistantMessage: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: finalText,
      messageType: MessageType.TEXT,
    };
    await useChatStore
      .getState()
      .finalizeMessage(assistantMessage, conversationWithUser);
  }
  useChatStore.getState().clearStreamingState();
}
