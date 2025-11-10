import { act, renderHook } from '@testing-library/react';

import { useCustomAgents } from '@/client/hooks/settings/useCustomAgents';

import type { OpenAIModelID } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';
import type { CustomAgent } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('useCustomAgents', () => {
  beforeEach(() => {
    // Reset the store to initial state before each test
    useSettingsStore.setState({
      customAgents: [],
    });
  });

  const createMockAgent = (overrides?: Partial<CustomAgent>): CustomAgent => ({
    id: 'agent-1',
    name: 'Test Agent',
    agentId: 'asst_test123',
    baseModelId: 'gpt-4' as OpenAIModelID,
    description: 'Test description',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  describe('Initial State', () => {
    it('returns empty array when no agents exist', () => {
      const { result } = renderHook(() => useCustomAgents());

      expect(result.current.customAgents).toEqual([]);
    });

    it('returns all functions', () => {
      const { result } = renderHook(() => useCustomAgents());

      expect(typeof result.current.addCustomAgent).toBe('function');
      expect(typeof result.current.updateCustomAgent).toBe('function');
      expect(typeof result.current.deleteCustomAgent).toBe('function');
    });

    it('returns existing agents from store', () => {
      const existingAgents = [
        createMockAgent({ id: 'agent-1', name: 'Agent 1' }),
        createMockAgent({ id: 'agent-2', name: 'Agent 2' }),
      ];

      useSettingsStore.setState({ customAgents: existingAgents });

      const { result } = renderHook(() => useCustomAgents());

      expect(result.current.customAgents).toHaveLength(2);
      expect(result.current.customAgents).toEqual(existingAgents);
    });
  });

  describe('addCustomAgent', () => {
    it('adds a new agent to empty list', () => {
      const { result } = renderHook(() => useCustomAgents());

      const newAgent = createMockAgent();

      act(() => {
        result.current.addCustomAgent(newAgent);
      });

      expect(result.current.customAgents).toHaveLength(1);
      expect(result.current.customAgents[0]).toEqual(newAgent);
    });

    it('adds a new agent to existing list', () => {
      const existingAgent = createMockAgent({ id: 'agent-1', name: 'First' });
      useSettingsStore.setState({ customAgents: [existingAgent] });

      const { result } = renderHook(() => useCustomAgents());

      const newAgent = createMockAgent({ id: 'agent-2', name: 'Second' });

      act(() => {
        result.current.addCustomAgent(newAgent);
      });

      expect(result.current.customAgents).toHaveLength(2);
      expect(result.current.customAgents[0]).toEqual(existingAgent);
      expect(result.current.customAgents[1]).toEqual(newAgent);
    });

    it('adds multiple agents sequentially', () => {
      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.addCustomAgent(
          createMockAgent({ id: 'agent-1', name: 'First' }),
        );
        result.current.addCustomAgent(
          createMockAgent({ id: 'agent-2', name: 'Second' }),
        );
        result.current.addCustomAgent(
          createMockAgent({ id: 'agent-3', name: 'Third' }),
        );
      });

      expect(result.current.customAgents).toHaveLength(3);
    });

    it('preserves agent properties correctly', () => {
      const { result } = renderHook(() => useCustomAgents());

      const agent: CustomAgent = {
        id: 'test-id',
        name: 'Research Assistant',
        agentId: 'asst_research123',
        baseModelId: 'gpt-4-turbo' as OpenAIModelID,
        description: 'Helps with research tasks',
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      act(() => {
        result.current.addCustomAgent(agent);
      });

      expect(result.current.customAgents[0]).toEqual(agent);
    });

    it('handles agents without optional description', () => {
      const { result } = renderHook(() => useCustomAgents());

      const agent: CustomAgent = {
        id: 'test-id',
        name: 'Simple Agent',
        agentId: 'asst_simple123',
        baseModelId: 'gpt-4' as OpenAIModelID,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      act(() => {
        result.current.addCustomAgent(agent);
      });

      expect(result.current.customAgents[0]).toEqual(agent);
      expect(result.current.customAgents[0].description).toBeUndefined();
    });
  });

  describe('updateCustomAgent', () => {
    it('updates agent name', () => {
      const agent = createMockAgent({ id: 'agent-1', name: 'Original Name' });
      useSettingsStore.setState({ customAgents: [agent] });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.updateCustomAgent('agent-1', { name: 'Updated Name' });
      });

      expect(result.current.customAgents[0].name).toBe('Updated Name');
    });

    it('updates agent description', () => {
      const agent = createMockAgent({ id: 'agent-1', description: 'Original' });
      useSettingsStore.setState({ customAgents: [agent] });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.updateCustomAgent('agent-1', {
          description: 'Updated description',
        });
      });

      expect(result.current.customAgents[0].description).toBe(
        'Updated description',
      );
    });

    it('updates multiple fields at once', () => {
      const agent = createMockAgent({
        id: 'agent-1',
        name: 'Original',
        description: 'Original desc',
      });
      useSettingsStore.setState({ customAgents: [agent] });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.updateCustomAgent('agent-1', {
          name: 'New Name',
          description: 'New description',
        });
      });

      expect(result.current.customAgents[0].name).toBe('New Name');
      expect(result.current.customAgents[0].description).toBe(
        'New description',
      );
    });

    it('preserves unchanged fields', () => {
      const agent = createMockAgent({
        id: 'agent-1',
        name: 'Original',
        agentId: 'asst_original',
        baseModelId: 'gpt-4' as OpenAIModelID,
      });
      useSettingsStore.setState({ customAgents: [agent] });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.updateCustomAgent('agent-1', { name: 'Updated' });
      });

      expect(result.current.customAgents[0].agentId).toBe('asst_original');
      expect(result.current.customAgents[0].baseModelId).toBe('gpt-4');
    });

    it('only updates the specified agent', () => {
      const agents = [
        createMockAgent({ id: 'agent-1', name: 'First' }),
        createMockAgent({ id: 'agent-2', name: 'Second' }),
        createMockAgent({ id: 'agent-3', name: 'Third' }),
      ];
      useSettingsStore.setState({ customAgents: agents });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.updateCustomAgent('agent-2', { name: 'Updated Second' });
      });

      expect(result.current.customAgents[0].name).toBe('First');
      expect(result.current.customAgents[1].name).toBe('Updated Second');
      expect(result.current.customAgents[2].name).toBe('Third');
    });

    it('does nothing if agent ID not found', () => {
      const agent = createMockAgent({ id: 'agent-1', name: 'Original' });
      useSettingsStore.setState({ customAgents: [agent] });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.updateCustomAgent('non-existent', { name: 'Updated' });
      });

      expect(result.current.customAgents[0].name).toBe('Original');
    });

    it('updates agent model', () => {
      const agent = createMockAgent({
        id: 'agent-1',
        baseModelId: 'gpt-4' as OpenAIModelID,
      });
      useSettingsStore.setState({ customAgents: [agent] });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.updateCustomAgent('agent-1', {
          baseModelId: 'gpt-4-turbo' as OpenAIModelID,
        });
      });

      expect(result.current.customAgents[0].baseModelId).toBe('gpt-4-turbo');
    });
  });

  describe('deleteCustomAgent', () => {
    it('deletes an agent by id', () => {
      const agent = createMockAgent({ id: 'agent-1' });
      useSettingsStore.setState({ customAgents: [agent] });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.deleteCustomAgent('agent-1');
      });

      expect(result.current.customAgents).toHaveLength(0);
    });

    it('deletes correct agent from multiple agents', () => {
      const agents = [
        createMockAgent({ id: 'agent-1', name: 'First' }),
        createMockAgent({ id: 'agent-2', name: 'Second' }),
        createMockAgent({ id: 'agent-3', name: 'Third' }),
      ];
      useSettingsStore.setState({ customAgents: agents });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.deleteCustomAgent('agent-2');
      });

      expect(result.current.customAgents).toHaveLength(2);
      expect(result.current.customAgents[0].id).toBe('agent-1');
      expect(result.current.customAgents[1].id).toBe('agent-3');
    });

    it('does nothing if agent ID not found', () => {
      const agent = createMockAgent({ id: 'agent-1' });
      useSettingsStore.setState({ customAgents: [agent] });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.deleteCustomAgent('non-existent');
      });

      expect(result.current.customAgents).toHaveLength(1);
    });

    it('handles deleting from empty list', () => {
      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.deleteCustomAgent('agent-1');
      });

      expect(result.current.customAgents).toHaveLength(0);
    });

    it('can delete multiple agents sequentially', () => {
      const agents = [
        createMockAgent({ id: 'agent-1', name: 'First' }),
        createMockAgent({ id: 'agent-2', name: 'Second' }),
        createMockAgent({ id: 'agent-3', name: 'Third' }),
      ];
      useSettingsStore.setState({ customAgents: agents });

      const { result } = renderHook(() => useCustomAgents());

      act(() => {
        result.current.deleteCustomAgent('agent-1');
        result.current.deleteCustomAgent('agent-3');
      });

      expect(result.current.customAgents).toHaveLength(1);
      expect(result.current.customAgents[0].id).toBe('agent-2');
    });
  });

  describe('Integration with Store', () => {
    it('reflects changes made directly to store', () => {
      const { result } = renderHook(() => useCustomAgents());

      const agent = createMockAgent();

      act(() => {
        useSettingsStore.getState().addCustomAgent(agent);
      });

      expect(result.current.customAgents).toHaveLength(1);
    });

    it('shares state across multiple hook instances', () => {
      const { result: result1 } = renderHook(() => useCustomAgents());
      const { result: result2 } = renderHook(() => useCustomAgents());

      const agent = createMockAgent();

      act(() => {
        result1.current.addCustomAgent(agent);
      });

      expect(result2.current.customAgents).toHaveLength(1);
      expect(result2.current.customAgents[0]).toEqual(agent);
    });

    it('updates are visible across all instances', () => {
      const agent = createMockAgent({ id: 'agent-1', name: 'Original' });
      useSettingsStore.setState({ customAgents: [agent] });

      const { result: result1 } = renderHook(() => useCustomAgents());
      const { result: result2 } = renderHook(() => useCustomAgents());

      act(() => {
        result1.current.updateCustomAgent('agent-1', { name: 'Updated' });
      });

      expect(result2.current.customAgents[0].name).toBe('Updated');
    });

    it('deletes are visible across all instances', () => {
      const agents = [
        createMockAgent({ id: 'agent-1', name: 'First' }),
        createMockAgent({ id: 'agent-2', name: 'Second' }),
      ];
      useSettingsStore.setState({ customAgents: agents });

      const { result: result1 } = renderHook(() => useCustomAgents());
      const { result: result2 } = renderHook(() => useCustomAgents());

      act(() => {
        result1.current.deleteCustomAgent('agent-1');
      });

      expect(result2.current.customAgents).toHaveLength(1);
      expect(result2.current.customAgents[0].id).toBe('agent-2');
    });
  });

  describe('Complex Workflows', () => {
    it('handles full CRUD cycle', () => {
      const { result } = renderHook(() => useCustomAgents());

      // Create
      const agent = createMockAgent({ id: 'agent-1', name: 'Test Agent' });
      act(() => {
        result.current.addCustomAgent(agent);
      });
      expect(result.current.customAgents).toHaveLength(1);

      // Update
      act(() => {
        result.current.updateCustomAgent('agent-1', { name: 'Updated Agent' });
      });
      expect(result.current.customAgents[0].name).toBe('Updated Agent');

      // Delete
      act(() => {
        result.current.deleteCustomAgent('agent-1');
      });
      expect(result.current.customAgents).toHaveLength(0);
    });

    it('handles managing multiple agents', () => {
      const { result } = renderHook(() => useCustomAgents());

      // Add multiple
      act(() => {
        result.current.addCustomAgent(
          createMockAgent({ id: 'agent-1', name: 'First' }),
        );
        result.current.addCustomAgent(
          createMockAgent({ id: 'agent-2', name: 'Second' }),
        );
        result.current.addCustomAgent(
          createMockAgent({ id: 'agent-3', name: 'Third' }),
        );
      });

      expect(result.current.customAgents).toHaveLength(3);

      // Update one
      act(() => {
        result.current.updateCustomAgent('agent-2', { description: 'Updated' });
      });

      // Delete one
      act(() => {
        result.current.deleteCustomAgent('agent-1');
      });

      expect(result.current.customAgents).toHaveLength(2);
      expect(result.current.customAgents[0].id).toBe('agent-2');
      expect(result.current.customAgents[0].description).toBe('Updated');
    });

    it('handles different agent configurations', () => {
      const { result } = renderHook(() => useCustomAgents());

      const gpt4Agent = createMockAgent({
        id: 'gpt4-agent',
        name: 'GPT-4 Agent',
        baseModelId: 'gpt-4' as OpenAIModelID,
        agentId: 'asst_gpt4',
      });

      const turboAgent = createMockAgent({
        id: 'turbo-agent',
        name: 'Turbo Agent',
        baseModelId: 'gpt-4-turbo' as OpenAIModelID,
        agentId: 'asst_turbo',
      });

      act(() => {
        result.current.addCustomAgent(gpt4Agent);
        result.current.addCustomAgent(turboAgent);
      });

      expect(result.current.customAgents).toHaveLength(2);
      expect(result.current.customAgents[0].baseModelId).toBe('gpt-4');
      expect(result.current.customAgents[1].baseModelId).toBe('gpt-4-turbo');
    });
  });
});
