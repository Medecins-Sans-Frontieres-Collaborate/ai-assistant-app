import { act, renderHook } from '@testing-library/react';

import { useAgentManagement } from '@/client/hooks/settings/useAgentManagement';

import { CustomAgent } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the useCustomAgents hook
const mockAddCustomAgent = vi.fn();
const mockUpdateCustomAgent = vi.fn();
const mockDeleteCustomAgent = vi.fn();
const mockCustomAgents: CustomAgent[] = [
  {
    id: 'agent-1',
    name: 'Test Agent 1',
    agentId: 'asst_test_1',
    baseModelId: 'gpt-4' as any,
    description: 'Description 1',
    createdAt: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 'agent-2',
    name: 'Test Agent 2',
    agentId: 'asst_test_2',
    baseModelId: 'gpt-3.5-turbo' as any,
    description: 'Description 2',
    createdAt: '2025-01-01T00:00:00.000Z',
  },
];

vi.mock('@/client/hooks/settings/useCustomAgents', () => ({
  useCustomAgents: vi.fn(() => ({
    customAgents: mockCustomAgents,
    addCustomAgent: mockAddCustomAgent,
    updateCustomAgent: mockUpdateCustomAgent,
    deleteCustomAgent: mockDeleteCustomAgent,
  })),
}));

describe('useAgentManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should return custom agents from store', () => {
      const { result } = renderHook(() => useAgentManagement());

      expect(result.current.customAgents).toEqual(mockCustomAgents);
    });
  });

  describe('handleSaveAgent', () => {
    it('should add new agent when id is not found', () => {
      const { result } = renderHook(() => useAgentManagement());

      const newAgent: CustomAgent = {
        id: 'agent-3',
        name: 'New Agent',
        agentId: 'asst_new',
        baseModelId: 'gpt-4' as any,
        description: 'New Description',
        createdAt: '2025-01-01T00:00:00.000Z',
      };

      act(() => {
        result.current.handleSaveAgent(newAgent);
      });

      expect(mockAddCustomAgent).toHaveBeenCalledWith(newAgent);
      expect(mockUpdateCustomAgent).not.toHaveBeenCalled();
    });

    it('should update existing agent when id is found', () => {
      const { result } = renderHook(() => useAgentManagement());

      const updatedAgent: CustomAgent = {
        ...mockCustomAgents[0],
        name: 'Updated Agent',
        description: 'Updated Description',
      };

      act(() => {
        result.current.handleSaveAgent(updatedAgent);
      });

      expect(mockUpdateCustomAgent).toHaveBeenCalledWith(
        'agent-1',
        updatedAgent,
      );
      expect(mockAddCustomAgent).not.toHaveBeenCalled();
    });

    it('should add agent when id is present but not in list', () => {
      const { result } = renderHook(() => useAgentManagement());

      const agentWithId: CustomAgent = {
        id: 'agent-999',
        name: 'Agent With ID',
        agentId: 'asst_999',
        baseModelId: 'gpt-4' as any,
        description: 'Description',
        createdAt: '2025-01-01T00:00:00.000Z',
      };

      act(() => {
        result.current.handleSaveAgent(agentWithId);
      });

      expect(mockAddCustomAgent).toHaveBeenCalledWith(agentWithId);
      expect(mockUpdateCustomAgent).not.toHaveBeenCalled();
    });
  });

  describe('handleImportAgents', () => {
    it('should add multiple agents', () => {
      const { result } = renderHook(() => useAgentManagement());

      const agentsToImport: CustomAgent[] = [
        {
          id: 'import-1',
          name: 'Imported Agent 1',
          agentId: 'asst_import_1',
          baseModelId: 'gpt-4' as any,
          description: 'Desc 1',
          createdAt: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 'import-2',
          name: 'Imported Agent 2',
          agentId: 'asst_import_2',
          baseModelId: 'gpt-3.5-turbo' as any,
          description: 'Desc 2',
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      ];

      act(() => {
        result.current.handleImportAgents(agentsToImport);
      });

      expect(mockAddCustomAgent).toHaveBeenCalledTimes(2);
      expect(mockAddCustomAgent).toHaveBeenCalledWith(agentsToImport[0]);
      expect(mockAddCustomAgent).toHaveBeenCalledWith(agentsToImport[1]);
    });

    it('should handle empty import list', () => {
      const { result } = renderHook(() => useAgentManagement());

      act(() => {
        result.current.handleImportAgents([]);
      });

      expect(mockAddCustomAgent).not.toHaveBeenCalled();
    });

    it('should import single agent', () => {
      const { result } = renderHook(() => useAgentManagement());

      const singleAgent: CustomAgent[] = [
        {
          id: 'import-1',
          name: 'Single Agent',
          agentId: 'asst_single',
          baseModelId: 'gpt-4' as any,
          description: 'Description',
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      ];

      act(() => {
        result.current.handleImportAgents(singleAgent);
      });

      expect(mockAddCustomAgent).toHaveBeenCalledTimes(1);
      expect(mockAddCustomAgent).toHaveBeenCalledWith(singleAgent[0]);
    });
  });

  describe('handleDeleteAgent', () => {
    it('should delete agent by id', () => {
      const { result } = renderHook(() => useAgentManagement());

      act(() => {
        result.current.handleDeleteAgent('agent-1');
      });

      expect(mockDeleteCustomAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should delete different agent', () => {
      const { result } = renderHook(() => useAgentManagement());

      act(() => {
        result.current.handleDeleteAgent('agent-2');
      });

      expect(mockDeleteCustomAgent).toHaveBeenCalledWith('agent-2');
    });

    it('should handle deleting non-existent agent', () => {
      const { result } = renderHook(() => useAgentManagement());

      act(() => {
        result.current.handleDeleteAgent('non-existent');
      });

      expect(mockDeleteCustomAgent).toHaveBeenCalledWith('non-existent');
    });
  });
});
