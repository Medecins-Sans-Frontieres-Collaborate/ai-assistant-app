'use client';

import { reviseVersions } from '@/client/services/workflows/drafter/drafterApi';
import { specNameOf } from '@/client/services/workflows/drafter/specNames';
import { voiceInputsFor } from '@/client/services/workflows/drafter/voiceInputs';

import { getSpecAdapter } from '@/lib/utils/shared/drafter/adapters';
import { DEFAULT_CHANNEL_SET_ID } from '@/lib/utils/shared/drafter/channels/channelSets';
import { includedItems } from '@/lib/utils/shared/drafter/core/brief';
import { landEdits } from '@/lib/utils/shared/drafter/core/revisions';
import { hasText } from '@/lib/utils/shared/drafter/core/versions';

import { Conversation, Message, MessageType } from '@/types/chat';
import { DraftSetState, RevisionScope } from '@/types/drafter';
import { WorkflowState } from '@/types/workflow';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import {
  EVERY_SPEC,
  useWorkflowRailStore,
} from '@/client/stores/workflowRailStore';
import { v4 as uuidv4 } from 'uuid';

type DrafterState = Extract<WorkflowState, DraftSetState>;

/** Which kind of spec each drafter workflow writes for. */
const SPEC_KIND: Record<DrafterState['kind'], string> = {
  'channel-drafter': 'channel',
};

/**
 * What the workspace knows and this module cannot: the rule set the draft
 * is drafting in (derived from the user's sets before the seed effect has
 * written it into state) and whether revising is paused, with the reason
 * to show (the draft's set is gone, or the user has none). Transient and
 * per conversation, like the rail scope; the workspace clears it on unmount.
 */
export interface RailContext {
  setId: string;
  /** Non-null = revisions are refused with this text as the reply. */
  blockedReason: string | null;
}

const railContexts = new Map<string, RailContext>();

export function setRailContext(
  conversationId: string,
  context: RailContext | null,
): void {
  if (context) railContexts.set(conversationId, context);
  else railContexts.delete(conversationId);
}

function drafterState(conversationId: string): DrafterState | undefined {
  const state = useConversationStore
    .getState()
    .conversations.find((c) => c.id === conversationId)?.workflowState;
  return state && state.kind in SPEC_KIND ? (state as DrafterState) : undefined;
}

/** The spec ids a scope addresses, limited to versions that have text. */
export function scopedSpecIds(
  state: DraftSetState,
  scope: RevisionScope,
): string[] {
  const wanted = scope.specIds.length > 0 ? scope.specIds : state.specIds;
  return wanted.filter(
    (id) => state.specIds.includes(id) && hasText(state.versions[id]),
  );
}

/**
 * Drafter override for the rail's send path. An instruction typed in the
 * rail is addressed to the scope shown on the "To:" line and comes back as
 * SUGGESTIONS on those versions, never as replaced text: the workspace
 * shows each one as a diff to accept or reject.
 */
export async function sendRailMessage(
  conversation: Conversation,
  text: string,
): Promise<void> {
  const conversationStore = useConversationStore.getState();
  const chatStore = useChatStore.getState();

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

  let reply = '';
  try {
    const state = drafterState(conversation.id);
    const specKind = state ? SPEC_KIND[state.kind] : undefined;
    const adapter = getSpecAdapter(specKind);
    const scope =
      useWorkflowRailStore.getState().scopes[conversation.id] ?? EVERY_SPEC;
    const specIds = state ? scopedSpecIds(state, scope) : [];
    const context = railContexts.get(conversation.id);

    if (context?.blockedReason) {
      // The workspace has paused the draft (its set is gone): the server
      // would refuse the dead set anyway, so say why instead.
      reply = context.blockedReason;
    } else if (!state || !adapter || !specKind || specIds.length === 0) {
      reply =
        'There is nothing written yet for me to revise. Write the posts first, then tell me what to change.';
    } else {
      const response = await reviseVersions(
        {
          specKind,
          // Specs resolve inside the draft's rule set: the one on the draft,
          // else the one the workspace shows (the same derivation as its
          // own requests), else the default.
          setId: state.setId ?? context?.setId ?? DEFAULT_CHANNEL_SET_ID,
          instruction: text,
          targets: specIds.map((specId) => ({
            specId,
            segments: state.versions[specId].segments.map((segment) => ({
              id: segment.id,
              text: segment.text,
            })),
            segmentId: specIds.length === 1 ? scope.segmentId : undefined,
          })),
          brief: {
            keyMessage: state.brief.keyMessage,
            callToAction: state.brief.callToAction,
            links: state.brief.links,
            language: state.brief.language || 'English',
            items: includedItems(state.brief).map((item) => ({
              id: item.id,
              kind: item.kind,
              text: item.text,
              attribution: item.attribution,
              verified: item.verified,
            })),
          },
          ...voiceInputsFor(state, specIds),
          modelId: conversation.model?.id,
          conversationId: conversation.id,
        },
        signal,
      );

      const landed: Array<{ name: string; count: number }> = [];
      const failed: string[] = [];
      useConversationStore
        .getState()
        .updateWorkflowState(conversation.id, (prev) => {
          // The state was read moments ago; if it has since gone or changed
          // kind, leave whatever is there untouched.
          if (!prev || !(prev.kind in SPEC_KIND)) return prev ?? state;
          let next = prev as DrafterState;
          const versions = { ...next.versions };
          for (const result of response.results) {
            const name = specNameOf(
              result.specId,
              adapter.resolveSpec(result.specId)?.name,
            );
            if (result.error) {
              failed.push(name);
              continue;
            }
            const version = versions[result.specId];
            if (!version) continue;
            const ids = result.edits.map(
              (_, index) => `e${(next.nextId + index).toString(36)}`,
            );
            next = { ...next, nextId: next.nextId + result.edits.length };
            const withEdits = landEdits(
              version,
              result.edits,
              next.brief,
              ids,
              text,
              specIds.length === 1 ? scope.segmentId : undefined,
            );
            versions[result.specId] = withEdits;
            landed.push({
              name,
              count: (withEdits.edits ?? []).filter(
                (edit) => edit.status === 'pending',
              ).length,
            });
          }
          return { ...next, versions };
        });

      const withChanges = landed.filter((entry) => entry.count > 0);
      const total = withChanges.reduce((sum, entry) => sum + entry.count, 0);
      reply =
        total === 0
          ? 'I found nothing to change for that instruction.'
          : `I suggested ${total} ${total === 1 ? 'change' : 'changes'} in ${withChanges
              .map((entry) => `${entry.name} (${entry.count})`)
              .join(
                ', ',
              )}. Each one is shown in its channel as a diff you can accept or reject. Nothing has been changed yet.`;
      if (failed.length > 0) {
        reply += ` I could not revise ${failed.join(', ')}; try again for ${failed.length === 1 ? 'that channel' : 'those channels'}.`;
      }
    }
  } catch (error) {
    if (!signal?.aborted) {
      reply = error instanceof Error ? error.message : 'The revision failed.';
    }
  }

  if (reply.trim()) {
    const assistantMessage: Message = {
      id: uuidv4(),
      role: 'assistant',
      content: reply,
      messageType: MessageType.TEXT,
    };
    await useChatStore
      .getState()
      .finalizeMessage(assistantMessage, conversationWithUser);
  }
  useChatStore.getState().clearStreamingState();
}
