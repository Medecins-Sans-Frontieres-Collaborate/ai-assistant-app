import { act, renderHook } from '@testing-library/react';

import { useModelSelectState } from '@/client/hooks/settings/useModelSelectState';

import { CustomAgent } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('useModelSelectState', () => {
  beforeEach(() => {
    // Clear any state between tests
  });

  describe('initial state', () => {
    it('should initialize with models tab when not an agent', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      expect(result.current.activeTab).toBe('models');
    });

    it('should initialize with agents tab when selected model is an agent', () => {
      const { result } = renderHook(() => useModelSelectState(true));

      expect(result.current.activeTab).toBe('agents');
    });

    it('should initialize with agent form closed', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      expect(result.current.showAgentForm).toBe(false);
      expect(result.current.editingAgent).toBeUndefined();
    });

    it('should initialize with advanced settings hidden', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      expect(result.current.showModelAdvanced).toBe(false);
    });

    it('should initialize with list view on mobile', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      expect(result.current.mobileView).toBe('list');
    });

    it('should initialize with agent warning hidden', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      expect(result.current.showAgentWarning).toBe(false);
    });
  });

  describe('tab management', () => {
    it('should switch to agents tab', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      expect(result.current.activeTab).toBe('models');

      act(() => {
        result.current.setActiveTab('agents');
      });

      expect(result.current.activeTab).toBe('agents');
    });

    it('should switch back to models tab', () => {
      const { result } = renderHook(() => useModelSelectState(true));

      expect(result.current.activeTab).toBe('agents');

      act(() => {
        result.current.setActiveTab('models');
      });

      expect(result.current.activeTab).toBe('models');
    });
  });

  describe('agent form management', () => {
    const mockAgent: CustomAgent = {
      id: 'agent-1',
      name: 'Test Agent',
      agentId: 'asst_test',
      baseModelId: 'gpt-4' as any,
      description: 'Test description',
      createdAt: '2025-01-01T00:00:00.000Z',
    };

    it('should open agent form for creating new agent', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      act(() => {
        result.current.openAgentForm();
      });

      expect(result.current.showAgentForm).toBe(true);
      expect(result.current.editingAgent).toBeUndefined();
    });

    it('should open agent form for editing existing agent', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      act(() => {
        result.current.openAgentForm(mockAgent);
      });

      expect(result.current.showAgentForm).toBe(true);
      expect(result.current.editingAgent).toBe(mockAgent);
    });

    it('should close agent form and clear editing agent', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      act(() => {
        result.current.openAgentForm(mockAgent);
      });

      expect(result.current.showAgentForm).toBe(true);
      expect(result.current.editingAgent).toBe(mockAgent);

      act(() => {
        result.current.closeAgentForm();
      });

      expect(result.current.showAgentForm).toBe(false);
      expect(result.current.editingAgent).toBeUndefined();
    });

    it('should allow direct setting of showAgentForm', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      act(() => {
        result.current.setShowAgentForm(true);
      });

      expect(result.current.showAgentForm).toBe(true);
    });

    it('should allow direct setting of editingAgent', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      act(() => {
        result.current.setEditingAgent(mockAgent);
      });

      expect(result.current.editingAgent).toBe(mockAgent);
    });
  });

  describe('advanced settings management', () => {
    it('should toggle advanced settings', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      expect(result.current.showModelAdvanced).toBe(false);

      act(() => {
        result.current.setShowModelAdvanced(true);
      });

      expect(result.current.showModelAdvanced).toBe(true);

      act(() => {
        result.current.setShowModelAdvanced(false);
      });

      expect(result.current.showModelAdvanced).toBe(false);
    });
  });

  describe('mobile view management', () => {
    it('should switch to details view', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      expect(result.current.mobileView).toBe('list');

      act(() => {
        result.current.setMobileView('details');
      });

      expect(result.current.mobileView).toBe('details');
    });

    it('should switch back to list view', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      act(() => {
        result.current.setMobileView('details');
      });

      expect(result.current.mobileView).toBe('details');

      act(() => {
        result.current.setMobileView('list');
      });

      expect(result.current.mobileView).toBe('list');
    });
  });

  describe('agent warning management', () => {
    it('should toggle agent warning', () => {
      const { result } = renderHook(() => useModelSelectState(false));

      expect(result.current.showAgentWarning).toBe(false);

      act(() => {
        result.current.setShowAgentWarning(true);
      });

      expect(result.current.showAgentWarning).toBe(true);

      act(() => {
        result.current.setShowAgentWarning(false);
      });

      expect(result.current.showAgentWarning).toBe(false);
    });
  });
});
