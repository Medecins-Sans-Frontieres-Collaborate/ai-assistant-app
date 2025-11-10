import { OpenAIModel, OpenAIModelID } from '@/types/openai';
import { Prompt } from '@/types/prompt';
import { SearchMode } from '@/types/searchMode';

import { CustomAgent, useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('settingsStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useSettingsStore.setState({
      temperature: 0.5,
      systemPrompt: '',
      defaultModelId: undefined,
      defaultSearchMode: SearchMode.INTELLIGENT,
      models: [],
      prompts: [],
      customAgents: [],
    });
  });

  describe('Initial State', () => {
    it('has correct initial state', () => {
      const state = useSettingsStore.getState();

      expect(state.temperature).toBe(0.5);
      expect(state.systemPrompt).toBe('');
      expect(state.defaultModelId).toBeUndefined();
      expect(state.defaultSearchMode).toBe(SearchMode.INTELLIGENT);
      expect(state.models).toEqual([]);
      expect(state.prompts).toEqual([]);
      expect(state.customAgents).toEqual([]);
    });
  });

  describe('Temperature', () => {
    describe('setTemperature', () => {
      it('sets temperature value', () => {
        useSettingsStore.getState().setTemperature(0.8);

        expect(useSettingsStore.getState().temperature).toBe(0.8);
      });

      it('updates temperature', () => {
        useSettingsStore.getState().setTemperature(0.3);
        expect(useSettingsStore.getState().temperature).toBe(0.3);

        useSettingsStore.getState().setTemperature(0.9);
        expect(useSettingsStore.getState().temperature).toBe(0.9);
      });

      it('accepts minimum temperature (0)', () => {
        useSettingsStore.getState().setTemperature(0);

        expect(useSettingsStore.getState().temperature).toBe(0);
      });

      it('accepts maximum temperature (1)', () => {
        useSettingsStore.getState().setTemperature(1);

        expect(useSettingsStore.getState().temperature).toBe(1);
      });
    });
  });

  describe('System Prompt', () => {
    describe('setSystemPrompt', () => {
      it('sets system prompt', () => {
        useSettingsStore
          .getState()
          .setSystemPrompt('You are a helpful assistant');

        expect(useSettingsStore.getState().systemPrompt).toBe(
          'You are a helpful assistant',
        );
      });

      it('updates system prompt', () => {
        useSettingsStore.getState().setSystemPrompt('First prompt');
        useSettingsStore.getState().setSystemPrompt('Second prompt');

        expect(useSettingsStore.getState().systemPrompt).toBe('Second prompt');
      });

      it('can set empty prompt', () => {
        useSettingsStore.getState().setSystemPrompt('Some prompt');
        useSettingsStore.getState().setSystemPrompt('');

        expect(useSettingsStore.getState().systemPrompt).toBe('');
      });

      it('handles multiline prompts', () => {
        const multilinePrompt = `You are a helpful assistant.
You should be polite.
You should be concise.`;

        useSettingsStore.getState().setSystemPrompt(multilinePrompt);

        expect(useSettingsStore.getState().systemPrompt).toBe(multilinePrompt);
      });
    });
  });

  describe('Default Model', () => {
    describe('setDefaultModelId', () => {
      it('sets default model ID', () => {
        useSettingsStore.getState().setDefaultModelId('gpt-4' as OpenAIModelID);

        expect(useSettingsStore.getState().defaultModelId).toBe('gpt-4');
      });

      it('updates default model ID', () => {
        useSettingsStore.getState().setDefaultModelId('gpt-4' as OpenAIModelID);
        useSettingsStore
          .getState()
          .setDefaultModelId('gpt-3.5-turbo' as OpenAIModelID);

        expect(useSettingsStore.getState().defaultModelId).toBe(
          'gpt-3.5-turbo',
        );
      });

      it('can set to undefined', () => {
        useSettingsStore.getState().setDefaultModelId('gpt-4' as OpenAIModelID);
        useSettingsStore.getState().setDefaultModelId(undefined);

        expect(useSettingsStore.getState().defaultModelId).toBeUndefined();
      });
    });
  });

  describe('Default Search Mode', () => {
    describe('setDefaultSearchMode', () => {
      it('sets default search mode', () => {
        useSettingsStore.getState().setDefaultSearchMode(SearchMode.AGENT);

        expect(useSettingsStore.getState().defaultSearchMode).toBe(
          SearchMode.AGENT,
        );
      });

      it('updates default search mode', () => {
        useSettingsStore.getState().setDefaultSearchMode(SearchMode.OFF);
        useSettingsStore.getState().setDefaultSearchMode(SearchMode.ALWAYS);

        expect(useSettingsStore.getState().defaultSearchMode).toBe(
          SearchMode.ALWAYS,
        );
      });

      it('can set to INTELLIGENT (default)', () => {
        useSettingsStore.getState().setDefaultSearchMode(SearchMode.OFF);
        useSettingsStore
          .getState()
          .setDefaultSearchMode(SearchMode.INTELLIGENT);

        expect(useSettingsStore.getState().defaultSearchMode).toBe(
          SearchMode.INTELLIGENT,
        );
      });

      it('persists all search mode values', () => {
        const modes = [
          SearchMode.OFF,
          SearchMode.INTELLIGENT,
          SearchMode.ALWAYS,
          SearchMode.AGENT,
        ];

        modes.forEach((mode) => {
          useSettingsStore.getState().setDefaultSearchMode(mode);
          expect(useSettingsStore.getState().defaultSearchMode).toBe(mode);
        });
      });
    });
  });

  describe('Models', () => {
    const createMockModel = (id: string, name: string): OpenAIModel => ({
      id: id as OpenAIModelID,
      name,
      maxLength: 4096,
      tokenLimit: 4096,
    });

    describe('setModels', () => {
      it('sets models array', () => {
        const models = [
          createMockModel('gpt-4', 'GPT-4'),
          createMockModel('gpt-3.5-turbo', 'GPT-3.5 Turbo'),
        ];

        useSettingsStore.getState().setModels(models);

        expect(useSettingsStore.getState().models).toEqual(models);
      });

      it('replaces existing models', () => {
        const first = [createMockModel('gpt-4', 'GPT-4')];
        const second = [createMockModel('gpt-3.5-turbo', 'GPT-3.5 Turbo')];

        useSettingsStore.getState().setModels(first);
        useSettingsStore.getState().setModels(second);

        expect(useSettingsStore.getState().models).toEqual(second);
      });

      it('can set empty array', () => {
        useSettingsStore
          .getState()
          .setModels([createMockModel('gpt-4', 'GPT-4')]);
        useSettingsStore.getState().setModels([]);

        expect(useSettingsStore.getState().models).toEqual([]);
      });
    });
  });

  describe('Prompts', () => {
    const createMockPrompt = (
      id: string,
      name: string,
      content: string,
    ): Prompt => ({
      id,
      name,
      description: '',
      content,
      model: {
        id: 'gpt-4' as OpenAIModelID,
        name: 'GPT-4',
        maxLength: 4096,
        tokenLimit: 4096,
      },
      folderId: null,
    });

    describe('setPrompts', () => {
      it('sets prompts array', () => {
        const prompts = [
          createMockPrompt('1', 'Prompt 1', 'Content 1'),
          createMockPrompt('2', 'Prompt 2', 'Content 2'),
        ];

        useSettingsStore.getState().setPrompts(prompts);

        expect(useSettingsStore.getState().prompts).toEqual(prompts);
      });

      it('replaces existing prompts', () => {
        const first = [createMockPrompt('1', 'First', 'Content')];
        const second = [createMockPrompt('2', 'Second', 'Content')];

        useSettingsStore.getState().setPrompts(first);
        useSettingsStore.getState().setPrompts(second);

        expect(useSettingsStore.getState().prompts).toEqual(second);
      });
    });

    describe('addPrompt', () => {
      it('adds prompt to empty list', () => {
        const prompt = createMockPrompt('1', 'Test', 'Content');

        useSettingsStore.getState().addPrompt(prompt);

        expect(useSettingsStore.getState().prompts).toHaveLength(1);
        expect(useSettingsStore.getState().prompts[0]).toEqual(prompt);
      });

      it('adds prompt to existing list', () => {
        const first = createMockPrompt('1', 'First', 'Content 1');
        const second = createMockPrompt('2', 'Second', 'Content 2');

        useSettingsStore.getState().addPrompt(first);
        useSettingsStore.getState().addPrompt(second);

        expect(useSettingsStore.getState().prompts).toHaveLength(2);
        expect(useSettingsStore.getState().prompts).toEqual([first, second]);
      });
    });

    describe('updatePrompt', () => {
      it('updates prompt name', () => {
        const prompt = createMockPrompt('1', 'Original', 'Content');
        useSettingsStore.getState().setPrompts([prompt]);

        useSettingsStore.getState().updatePrompt('1', { name: 'Updated' });

        expect(useSettingsStore.getState().prompts[0].name).toBe('Updated');
      });

      it('updates prompt content', () => {
        const prompt = createMockPrompt('1', 'Test', 'Original content');
        useSettingsStore.getState().setPrompts([prompt]);

        useSettingsStore
          .getState()
          .updatePrompt('1', { content: 'Updated content' });

        expect(useSettingsStore.getState().prompts[0].content).toBe(
          'Updated content',
        );
      });

      it('updates multiple fields', () => {
        const prompt = createMockPrompt('1', 'Test', 'Content');
        useSettingsStore.getState().setPrompts([prompt]);

        useSettingsStore.getState().updatePrompt('1', {
          name: 'New Name',
          content: 'New Content',
          description: 'New Description',
        });

        const updated = useSettingsStore.getState().prompts[0];
        expect(updated.name).toBe('New Name');
        expect(updated.content).toBe('New Content');
        expect(updated.description).toBe('New Description');
      });

      it('only updates matching prompt', () => {
        const prompts = [
          createMockPrompt('1', 'First', 'Content 1'),
          createMockPrompt('2', 'Second', 'Content 2'),
        ];
        useSettingsStore.getState().setPrompts(prompts);

        useSettingsStore.getState().updatePrompt('1', { name: 'Updated' });

        const all = useSettingsStore.getState().prompts;
        expect(all[0].name).toBe('Updated');
        expect(all[1].name).toBe('Second');
      });

      it('does nothing if prompt not found', () => {
        const prompt = createMockPrompt('1', 'Test', 'Content');
        useSettingsStore.getState().setPrompts([prompt]);

        useSettingsStore.getState().updatePrompt('999', { name: 'Updated' });

        expect(useSettingsStore.getState().prompts[0].name).toBe('Test');
      });
    });

    describe('deletePrompt', () => {
      it('deletes prompt from list', () => {
        const prompts = [
          createMockPrompt('1', 'First', 'Content 1'),
          createMockPrompt('2', 'Second', 'Content 2'),
        ];
        useSettingsStore.getState().setPrompts(prompts);

        useSettingsStore.getState().deletePrompt('1');

        const remaining = useSettingsStore.getState().prompts;
        expect(remaining).toHaveLength(1);
        expect(remaining[0].id).toBe('2');
      });

      it('handles deleting non-existent prompt', () => {
        const prompt = createMockPrompt('1', 'Test', 'Content');
        useSettingsStore.getState().setPrompts([prompt]);

        useSettingsStore.getState().deletePrompt('999');

        expect(useSettingsStore.getState().prompts).toHaveLength(1);
      });

      it('can delete last prompt', () => {
        const prompt = createMockPrompt('1', 'Test', 'Content');
        useSettingsStore.getState().setPrompts([prompt]);

        useSettingsStore.getState().deletePrompt('1');

        expect(useSettingsStore.getState().prompts).toEqual([]);
      });
    });
  });

  describe('Custom Agents', () => {
    const createMockAgent = (
      id: string,
      name: string,
      agentId: string,
    ): CustomAgent => ({
      id,
      name,
      agentId,
      baseModelId: 'gpt-4' as OpenAIModelID,
      description: 'Test agent',
      createdAt: new Date().toISOString(),
    });

    describe('setCustomAgents', () => {
      it('sets custom agents array', () => {
        const agents = [
          createMockAgent('1', 'Agent 1', 'agent-1'),
          createMockAgent('2', 'Agent 2', 'agent-2'),
        ];

        useSettingsStore.getState().setCustomAgents(agents);

        expect(useSettingsStore.getState().customAgents).toEqual(agents);
      });

      it('replaces existing agents', () => {
        const first = [createMockAgent('1', 'First', 'agent-1')];
        const second = [createMockAgent('2', 'Second', 'agent-2')];

        useSettingsStore.getState().setCustomAgents(first);
        useSettingsStore.getState().setCustomAgents(second);

        expect(useSettingsStore.getState().customAgents).toEqual(second);
      });
    });

    describe('addCustomAgent', () => {
      it('adds agent to empty list', () => {
        const agent = createMockAgent('1', 'Test', 'agent-1');

        useSettingsStore.getState().addCustomAgent(agent);

        expect(useSettingsStore.getState().customAgents).toHaveLength(1);
        expect(useSettingsStore.getState().customAgents[0]).toEqual(agent);
      });

      it('adds agent to existing list', () => {
        const first = createMockAgent('1', 'First', 'agent-1');
        const second = createMockAgent('2', 'Second', 'agent-2');

        useSettingsStore.getState().addCustomAgent(first);
        useSettingsStore.getState().addCustomAgent(second);

        expect(useSettingsStore.getState().customAgents).toHaveLength(2);
        expect(useSettingsStore.getState().customAgents).toEqual([
          first,
          second,
        ]);
      });
    });

    describe('updateCustomAgent', () => {
      it('updates agent name', () => {
        const agent = createMockAgent('1', 'Original', 'agent-1');
        useSettingsStore.getState().setCustomAgents([agent]);

        useSettingsStore.getState().updateCustomAgent('1', { name: 'Updated' });

        expect(useSettingsStore.getState().customAgents[0].name).toBe(
          'Updated',
        );
      });

      it('updates agent description', () => {
        const agent = createMockAgent('1', 'Test', 'agent-1');
        useSettingsStore.getState().setCustomAgents([agent]);

        useSettingsStore
          .getState()
          .updateCustomAgent('1', { description: 'New description' });

        expect(useSettingsStore.getState().customAgents[0].description).toBe(
          'New description',
        );
      });

      it('updates multiple fields', () => {
        const agent = createMockAgent('1', 'Test', 'agent-1');
        useSettingsStore.getState().setCustomAgents([agent]);

        useSettingsStore.getState().updateCustomAgent('1', {
          name: 'New Name',
          description: 'New Description',
        });

        const updated = useSettingsStore.getState().customAgents[0];
        expect(updated.name).toBe('New Name');
        expect(updated.description).toBe('New Description');
      });

      it('only updates matching agent', () => {
        const agents = [
          createMockAgent('1', 'First', 'agent-1'),
          createMockAgent('2', 'Second', 'agent-2'),
        ];
        useSettingsStore.getState().setCustomAgents(agents);

        useSettingsStore.getState().updateCustomAgent('1', { name: 'Updated' });

        const all = useSettingsStore.getState().customAgents;
        expect(all[0].name).toBe('Updated');
        expect(all[1].name).toBe('Second');
      });

      it('does nothing if agent not found', () => {
        const agent = createMockAgent('1', 'Test', 'agent-1');
        useSettingsStore.getState().setCustomAgents([agent]);

        useSettingsStore
          .getState()
          .updateCustomAgent('999', { name: 'Updated' });

        expect(useSettingsStore.getState().customAgents[0].name).toBe('Test');
      });
    });

    describe('deleteCustomAgent', () => {
      it('deletes agent from list', () => {
        const agents = [
          createMockAgent('1', 'First', 'agent-1'),
          createMockAgent('2', 'Second', 'agent-2'),
        ];
        useSettingsStore.getState().setCustomAgents(agents);

        useSettingsStore.getState().deleteCustomAgent('1');

        const remaining = useSettingsStore.getState().customAgents;
        expect(remaining).toHaveLength(1);
        expect(remaining[0].id).toBe('2');
      });

      it('handles deleting non-existent agent', () => {
        const agent = createMockAgent('1', 'Test', 'agent-1');
        useSettingsStore.getState().setCustomAgents([agent]);

        useSettingsStore.getState().deleteCustomAgent('999');

        expect(useSettingsStore.getState().customAgents).toHaveLength(1);
      });

      it('can delete last agent', () => {
        const agent = createMockAgent('1', 'Test', 'agent-1');
        useSettingsStore.getState().setCustomAgents([agent]);

        useSettingsStore.getState().deleteCustomAgent('1');

        expect(useSettingsStore.getState().customAgents).toEqual([]);
      });
    });
  });

  describe('resetSettings', () => {
    it('resets to default values', () => {
      // Set all settings to non-default values
      useSettingsStore.setState({
        temperature: 0.9,
        systemPrompt: 'Custom prompt',
        defaultModelId: 'gpt-4' as OpenAIModelID,
        defaultSearchMode: SearchMode.OFF,
        models: [
          {
            id: 'gpt-4' as OpenAIModelID,
            name: 'GPT-4',
            maxLength: 4096,
            tokenLimit: 4096,
          },
        ],
        prompts: [
          {
            id: '1',
            name: 'Test',
            description: '',
            content: 'Content',
            model: {
              id: 'gpt-4' as OpenAIModelID,
              name: 'GPT-4',
              maxLength: 4096,
              tokenLimit: 4096,
            },
            folderId: null,
          },
        ],
        customAgents: [
          {
            id: '1',
            name: 'Agent',
            agentId: 'agent-1',
            baseModelId: 'gpt-4' as OpenAIModelID,
            createdAt: new Date().toISOString(),
          },
        ],
      });

      useSettingsStore.getState().resetSettings();

      const state = useSettingsStore.getState();
      expect(state.temperature).toBe(0.5);
      expect(state.systemPrompt).toBe('');
      expect(state.defaultSearchMode).toBe(SearchMode.INTELLIGENT);
      expect(state.prompts).toEqual([]);
      expect(state.customAgents).toEqual([]);
    });

    it('preserves models and defaultModelId', () => {
      const models = [
        {
          id: 'gpt-4' as OpenAIModelID,
          name: 'GPT-4',
          maxLength: 4096,
          tokenLimit: 4096,
        },
      ];
      useSettingsStore.setState({
        models,
        defaultModelId: 'gpt-4' as OpenAIModelID,
      });

      useSettingsStore.getState().resetSettings();

      // Models and defaultModelId are preserved
      expect(useSettingsStore.getState().models).toEqual(models);
      expect(useSettingsStore.getState().defaultModelId).toBe('gpt-4');
    });

    it('can be called on already reset state', () => {
      useSettingsStore.getState().resetSettings();

      const state = useSettingsStore.getState();
      expect(state.temperature).toBe(0.5);
      expect(state.systemPrompt).toBe('');
      expect(state.prompts).toEqual([]);
    });
  });

  describe('State Isolation', () => {
    it('changes do not affect subsequent tests', () => {
      useSettingsStore.getState().setTemperature(0.9);
      useSettingsStore.getState().setSystemPrompt('Test');

      // Manually reset (beforeEach also does this)
      useSettingsStore.setState({
        temperature: 0.5,
        systemPrompt: '',
        defaultModelId: undefined,
        defaultSearchMode: SearchMode.INTELLIGENT,
        models: [],
        prompts: [],
        customAgents: [],
      });

      const state = useSettingsStore.getState();
      expect(state.temperature).toBe(0.5);
      expect(state.systemPrompt).toBe('');
      expect(state.defaultSearchMode).toBe(SearchMode.INTELLIGENT);
    });
  });
});
