import { Conversation } from '@/types/chat';
import { TranslationWorkflowState, WorkflowState } from '@/types/workflow';

import { useConversationStore } from '@/client/stores/conversationStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMockConversation = (
  id: string,
  overrides: Partial<Conversation> = {},
): Conversation => ({
  id,
  name: '',
  messages: [],
  model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
  prompt: '',
  temperature: 0.7,
  folderId: null,
  ...overrides,
});

/** A conversation that has been sent to — enough to settle its type. */
const sentMessages = (): Conversation['messages'] => [
  { role: 'user', content: 'hello' } as Conversation['messages'][number],
];

const translationState = (
  overrides: Partial<TranslationWorkflowState> = {},
): TranslationWorkflowState => ({
  kind: 'translation',
  sourceText: '',
  mode: 'agentic',
  rounds: [],
  updatedAt: '2026-07-09T00:00:00.000Z',
  ...overrides,
});

describe('conversationStore workflows', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      folders: [],
      searchTerm: '',
      isLoaded: false,
    });
    vi.restoreAllMocks();
  });

  it('stores a workflow conversation with its type and state', () => {
    const conversation = createMockConversation('w1', {
      conversationType: 'translation',
      workflowState: translationState(),
    });

    useConversationStore.getState().addConversation(conversation);

    const stored = useConversationStore.getState().conversations[0];
    expect(stored.conversationType).toBe('translation');
    expect(stored.workflowState?.kind).toBe('translation');
  });

  describe('updateConversation type guard', () => {
    // The type is settled by the first message, not the first selection —
    // WorkflowTabs lets the user switch modes while the conversation is
    // still empty.
    it('allows changing conversationType while the conversation is empty', () => {
      useConversationStore.getState().addConversation(
        createMockConversation('w1', {
          conversationType: 'translation',
          workflowState: translationState(),
        }),
      );

      useConversationStore.getState().updateConversation('w1', {
        conversationType: 'map',
        workflowState: {
          kind: 'map',
          features: [],
          sources: [],
          updatedAt: '',
        },
      });

      const stored = useConversationStore.getState().conversations[0];
      expect(stored.conversationType).toBe('map');
      expect(stored.workflowState?.kind).toBe('map');
    });

    it('allows clearing conversationType back to plain chat while empty', () => {
      useConversationStore.getState().addConversation(
        createMockConversation('w1', {
          conversationType: 'translation',
          workflowState: translationState(),
        }),
      );

      useConversationStore.getState().updateConversation('w1', {
        conversationType: undefined,
        workflowState: undefined,
      });

      const stored = useConversationStore.getState().conversations[0];
      expect(stored.conversationType).toBeUndefined();
      expect(stored.workflowState).toBeUndefined();
    });

    it('strips attempts to change conversationType once there are messages', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      useConversationStore.getState().addConversation(
        createMockConversation('w1', {
          conversationType: 'translation',
          workflowState: translationState({ sourceText: 'bonjour' }),
          messages: sentMessages(),
        }),
      );

      useConversationStore.getState().updateConversation('w1', {
        conversationType: 'map',
        name: 'renamed',
      } as Partial<Conversation>);

      const stored = useConversationStore.getState().conversations[0];
      expect(stored.conversationType).toBe('translation');
      // Non-type fields in the same patch still apply.
      expect(stored.name).toBe('renamed');
      expect(warn).toHaveBeenCalled();
    });

    it('strips workflowState alongside a rejected type change', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      useConversationStore.getState().addConversation(
        createMockConversation('w1', {
          conversationType: 'translation',
          workflowState: translationState({ sourceText: 'bonjour' }),
          messages: sentMessages(),
        }),
      );

      useConversationStore.getState().updateConversation('w1', {
        conversationType: 'map',
        workflowState: {
          kind: 'map',
          features: [],
          sources: [],
          updatedAt: '',
        },
      });

      // Letting the state through while rejecting the type would leave a
      // workflowState whose `kind` disagrees with conversationType.
      const stored = useConversationStore.getState().conversations[0];
      expect(stored.conversationType).toBe('translation');
      expect(stored.workflowState?.kind).toBe('translation');
      expect(
        (stored.workflowState as TranslationWorkflowState).sourceText,
      ).toBe('bonjour');
    });

    it('allows setting conversationType on an untyped conversation', () => {
      useConversationStore
        .getState()
        .addConversation(createMockConversation('c1'));

      useConversationStore.getState().updateConversation('c1', {
        conversationType: 'document',
      });

      expect(
        useConversationStore.getState().conversations[0].conversationType,
      ).toBe('document');
    });
  });

  describe('updateWorkflowState', () => {
    it('applies an updater whose kind matches the conversation type', () => {
      useConversationStore.getState().addConversation(
        createMockConversation('w1', {
          conversationType: 'translation',
          workflowState: translationState(),
        }),
      );

      useConversationStore.getState().updateWorkflowState('w1', (prev) => ({
        ...(prev as TranslationWorkflowState),
        sourceText: 'Bonjour',
      }));

      const stored = useConversationStore.getState().conversations[0];
      expect(
        (stored.workflowState as TranslationWorkflowState).sourceText,
      ).toBe('Bonjour');
    });

    it('is a complete no-op when the updater returns the previous state', () => {
      useConversationStore.getState().addConversation(
        createMockConversation('w1', {
          conversationType: 'translation',
          workflowState: translationState(),
        }),
      );
      const before = useConversationStore.getState();
      const notified = vi.fn();
      const unsubscribe = useConversationStore.subscribe(notified);

      // Updater signals "nothing to write" by returning prev unchanged —
      // the map-view persistence path relies on this to break moveend →
      // write → re-render feedback loops.
      useConversationStore
        .getState()
        .updateWorkflowState('w1', (prev) => prev!);

      const after = useConversationStore.getState();
      expect(after.conversations).toBe(before.conversations);
      expect(after.conversations[0].updatedAt).toBe(
        before.conversations[0].updatedAt,
      );
      expect(notified).not.toHaveBeenCalled();
      unsubscribe();
    });

    it('refuses a state whose kind mismatches the conversation type', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      useConversationStore.getState().addConversation(
        createMockConversation('w1', {
          conversationType: 'translation',
          workflowState: translationState({ sourceText: 'original' }),
        }),
      );

      useConversationStore.getState().updateWorkflowState(
        'w1',
        () =>
          ({
            kind: 'map',
            features: [],
            sources: [],
            updatedAt: '2026-07-09T00:00:00.000Z',
          }) as WorkflowState,
      );

      const stored = useConversationStore.getState().conversations[0];
      expect(stored.workflowState?.kind).toBe('translation');
      expect(
        (stored.workflowState as TranslationWorkflowState).sourceText,
      ).toBe('original');
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('v6 migration', () => {
    // Access the persist migrate function the same way existing migration
    // tests do: through the persist API's options.
    const migrate = (
      useConversationStore.persist as unknown as {
        getOptions: () => {
          migrate: (
            state: unknown,
            version: number,
          ) => {
            conversations: Conversation[];
          };
        };
      }
    ).getOptions().migrate;

    it('drops an invalid conversationType and its state', () => {
      const result = migrate(
        {
          conversations: [
            {
              ...createMockConversation('bad'),
              conversationType: 'spreadsheet',
              workflowState: { kind: 'spreadsheet' },
            },
          ],
          selectedConversationId: null,
          folders: [],
        },
        5,
      );

      expect(result.conversations[0].conversationType).toBeUndefined();
      expect(result.conversations[0].workflowState).toBeUndefined();
    });

    it('drops a workflowState whose kind mismatches the type', () => {
      const result = migrate(
        {
          conversations: [
            {
              ...createMockConversation('mismatch'),
              conversationType: 'translation',
              workflowState: { kind: 'map', features: [], sources: [] },
            },
          ],
          selectedConversationId: null,
          folders: [],
        },
        5,
      );

      expect(result.conversations[0].conversationType).toBe('translation');
      expect(result.conversations[0].workflowState).toBeUndefined();
    });

    it('leaves valid workflow conversations untouched', () => {
      const valid = {
        ...createMockConversation('ok'),
        conversationType: 'translation',
        workflowState: translationState(),
      };
      const result = migrate(
        {
          conversations: [valid],
          selectedConversationId: null,
          folders: [],
        },
        5,
      );

      expect(result.conversations[0]).toEqual(valid);
    });
  });
});
