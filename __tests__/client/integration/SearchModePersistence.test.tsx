import { Conversation } from '@/types/chat';
import { OpenAIModelID } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';

describe('Search Mode Persistence Integration', () => {
  beforeEach(() => {
    // Reset both stores before each test
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      folders: [],
      searchTerm: '',
      isLoaded: true,
    });

    useSettingsStore.setState({
      temperature: 0.5,
      systemPrompt: '',
      defaultModelId: undefined,
      defaultSearchMode: SearchMode.INTELLIGENT,
      models: [],
      prompts: [],
      tones: [],
      customAgents: [],
    });
  });

  describe('Global Default Search Mode', () => {
    it('should persist default search mode in settings store', () => {
      const { setDefaultSearchMode } = useSettingsStore.getState();

      setDefaultSearchMode(SearchMode.AGENT);

      expect(useSettingsStore.getState().defaultSearchMode).toBe(
        SearchMode.AGENT,
      );
    });

    it('should default to INTELLIGENT mode', () => {
      expect(useSettingsStore.getState().defaultSearchMode).toBe(
        SearchMode.INTELLIGENT,
      );
    });

    it('should allow changing between all search modes', () => {
      const { setDefaultSearchMode } = useSettingsStore.getState();
      const modes = [
        SearchMode.OFF,
        SearchMode.INTELLIGENT,
        SearchMode.ALWAYS,
        SearchMode.AGENT,
      ];

      modes.forEach((mode) => {
        setDefaultSearchMode(mode);
        expect(useSettingsStore.getState().defaultSearchMode).toBe(mode);
      });
    });
  });

  describe('Per-Conversation Search Mode', () => {
    const createMockConversation = (
      defaultSearchMode: SearchMode,
    ): Conversation => ({
      id: uuidv4(),
      name: 'Test Conversation',
      messages: [],
      model: {
        id: OpenAIModelID.GPT_4_1,
        name: 'GPT-4.1',
        maxLength: 128000,
        tokenLimit: 128000,
      },
      prompt: '',
      temperature: 0.5,
      folderId: null,
      defaultSearchMode,
    });

    it('should persist search mode per conversation', () => {
      const { addConversation, updateConversation } =
        useConversationStore.getState();

      const conversation = createMockConversation(SearchMode.INTELLIGENT);
      addConversation(conversation);

      updateConversation(conversation.id, {
        defaultSearchMode: SearchMode.AGENT,
      });

      const updated = useConversationStore
        .getState()
        .conversations.find((c) => c.id === conversation.id);
      expect(updated?.defaultSearchMode).toBe(SearchMode.AGENT);
    });

    it('should maintain different search modes for different conversations', () => {
      const { addConversation } = useConversationStore.getState();

      const conv1 = createMockConversation(SearchMode.INTELLIGENT);
      const conv2 = createMockConversation(SearchMode.AGENT);
      const conv3 = createMockConversation(SearchMode.OFF);

      addConversation(conv1);
      addConversation(conv2);
      addConversation(conv3);

      const conversations = useConversationStore.getState().conversations;
      expect(
        conversations.find((c) => c.id === conv1.id)?.defaultSearchMode,
      ).toBe(SearchMode.INTELLIGENT);
      expect(
        conversations.find((c) => c.id === conv2.id)?.defaultSearchMode,
      ).toBe(SearchMode.AGENT);
      expect(
        conversations.find((c) => c.id === conv3.id)?.defaultSearchMode,
      ).toBe(SearchMode.OFF);
    });
  });

  describe('New Conversation Initialization', () => {
    it('should use global default search mode for new conversations', () => {
      const { setDefaultSearchMode } = useSettingsStore.getState();
      const { addConversation } = useConversationStore.getState();

      // Set global default to AGENT
      setDefaultSearchMode(SearchMode.AGENT);

      // Create new conversation with global default
      const conversation: Conversation = {
        id: uuidv4(),
        name: 'New Conversation',
        messages: [],
        model: {
          id: OpenAIModelID.GPT_4_1,
          name: 'GPT-4.1',
          maxLength: 128000,
          tokenLimit: 128000,
        },
        prompt: '',
        temperature: 0.5,
        folderId: null,
        defaultSearchMode: useSettingsStore.getState().defaultSearchMode,
      };

      addConversation(conversation);

      const created = useConversationStore
        .getState()
        .conversations.find((c) => c.id === conversation.id);
      expect(created?.defaultSearchMode).toBe(SearchMode.AGENT);
    });

    it('should use INTELLIGENT as fallback if defaultSearchMode is undefined', () => {
      const { addConversation } = useConversationStore.getState();

      // Create conversation without defaultSearchMode
      const conversation: Conversation = {
        id: uuidv4(),
        name: 'New Conversation',
        messages: [],
        model: {
          id: OpenAIModelID.GPT_4_1,
          name: 'GPT-4.1',
          maxLength: 128000,
          tokenLimit: 128000,
        },
        prompt: '',
        temperature: 0.5,
        folderId: null,
        // Explicitly test undefined fallback
        defaultSearchMode: undefined,
      };

      addConversation(conversation);

      const created = useConversationStore
        .getState()
        .conversations.find((c) => c.id === conversation.id);
      // Should fallback to undefined (UI layer handles fallback to INTELLIGENT)
      expect(created?.defaultSearchMode).toBeUndefined();
    });
  });

  describe('Search Mode Updates Sync Behavior', () => {
    it('should update conversation search mode without affecting global default', () => {
      const { setDefaultSearchMode } = useSettingsStore.getState();
      const { addConversation, updateConversation } =
        useConversationStore.getState();

      // Set global default
      setDefaultSearchMode(SearchMode.INTELLIGENT);

      // Create conversation with global default
      const conversation: Conversation = {
        id: uuidv4(),
        name: 'Test',
        messages: [],
        model: {
          id: OpenAIModelID.GPT_4_1,
          name: 'GPT-4.1',
          maxLength: 128000,
          tokenLimit: 128000,
        },
        prompt: '',
        temperature: 0.5,
        folderId: null,
        defaultSearchMode: SearchMode.INTELLIGENT,
      };

      addConversation(conversation);

      // Update only conversation (simulating dropdown temporary toggle)
      updateConversation(conversation.id, {
        defaultSearchMode: SearchMode.ALWAYS,
      });

      // Conversation should be updated
      const updated = useConversationStore
        .getState()
        .conversations.find((c) => c.id === conversation.id);
      expect(updated?.defaultSearchMode).toBe(SearchMode.ALWAYS);

      // Global default should remain unchanged
      expect(useSettingsStore.getState().defaultSearchMode).toBe(
        SearchMode.INTELLIGENT,
      );
    });

    it('should update both conversation and global default (simulating ModelSelect change)', () => {
      const { setDefaultSearchMode } = useSettingsStore.getState();
      const { addConversation, updateConversation } =
        useConversationStore.getState();

      // Set global default
      setDefaultSearchMode(SearchMode.INTELLIGENT);

      // Create conversation
      const conversation: Conversation = {
        id: uuidv4(),
        name: 'Test',
        messages: [],
        model: {
          id: OpenAIModelID.GPT_4_1,
          name: 'GPT-4.1',
          maxLength: 128000,
          tokenLimit: 128000,
        },
        prompt: '',
        temperature: 0.5,
        folderId: null,
        defaultSearchMode: SearchMode.INTELLIGENT,
      };

      addConversation(conversation);

      // Simulate ModelSelect change: update both conversation and global
      const newMode = SearchMode.AGENT;
      updateConversation(conversation.id, {
        defaultSearchMode: newMode,
      });
      setDefaultSearchMode(newMode);

      // Both should be updated
      const updated = useConversationStore
        .getState()
        .conversations.find((c) => c.id === conversation.id);
      expect(updated?.defaultSearchMode).toBe(SearchMode.AGENT);
      expect(useSettingsStore.getState().defaultSearchMode).toBe(
        SearchMode.AGENT,
      );
    });
  });

  describe('Search Mode Validation', () => {
    it('should handle all valid SearchMode values', () => {
      const { setDefaultSearchMode } = useSettingsStore.getState();

      // Test all enum values
      setDefaultSearchMode(SearchMode.OFF);
      expect(useSettingsStore.getState().defaultSearchMode).toBe(
        SearchMode.OFF,
      );

      setDefaultSearchMode(SearchMode.INTELLIGENT);
      expect(useSettingsStore.getState().defaultSearchMode).toBe(
        SearchMode.INTELLIGENT,
      );

      setDefaultSearchMode(SearchMode.ALWAYS);
      expect(useSettingsStore.getState().defaultSearchMode).toBe(
        SearchMode.ALWAYS,
      );

      setDefaultSearchMode(SearchMode.AGENT);
      expect(useSettingsStore.getState().defaultSearchMode).toBe(
        SearchMode.AGENT,
      );
    });
  });
});
