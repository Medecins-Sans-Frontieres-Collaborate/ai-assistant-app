import { act, renderHook } from '@testing-library/react';

import { useUI } from '@/client/hooks/ui/useUI';

import * as UIPreferencesProvider from '@/components/Providers/UIPreferencesProvider';

import { useUIStore } from '@/client/stores/uiStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the UIPreferencesProvider module
vi.mock('@/components/Providers/UIPreferencesProvider', () => ({
  useUIPreferences: vi.fn(),
}));

describe('useUI', () => {
  const mockPreferences = {
    showChatbar: true,
    showPromptbar: true,
    theme: 'light' as const,
    setShowChatbar: vi.fn(),
    toggleChatbar: vi.fn(),
    setShowPromptbar: vi.fn(),
    togglePromptbar: vi.fn(),
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
  };

  beforeEach(() => {
    // Reset UI store to initial state
    useUIStore.setState({
      isSettingsOpen: false,
      isBotModalOpen: false,
      isTermsModalOpen: false,
      loading: false,
    });

    // Reset mock functions
    vi.clearAllMocks();

    // Setup default mock return value
    vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue(
      mockPreferences,
    );
  });

  describe('Initial State', () => {
    it('returns combined state from preferences and UI store', () => {
      const { result } = renderHook(() => useUI());

      // Preferences
      expect(result.current.showChatbar).toBe(true);
      expect(result.current.showPromptbar).toBe(true);
      expect(result.current.theme).toBe('light');

      // Modal states
      expect(result.current.isSettingsOpen).toBe(false);
      expect(result.current.isBotModalOpen).toBe(false);
      expect(result.current.isTermsModalOpen).toBe(false);
      expect(result.current.loading).toBe(false);
    });

    it('returns all preference functions', () => {
      const { result } = renderHook(() => useUI());

      expect(typeof result.current.setShowChatbar).toBe('function');
      expect(typeof result.current.toggleChatbar).toBe('function');
      expect(typeof result.current.setShowPromptbar).toBe('function');
      expect(typeof result.current.togglePromptbar).toBe('function');
      expect(typeof result.current.setTheme).toBe('function');
      expect(typeof result.current.toggleTheme).toBe('function');
    });

    it('returns all modal state functions', () => {
      const { result } = renderHook(() => useUI());

      expect(typeof result.current.setIsSettingsOpen).toBe('function');
      expect(typeof result.current.setIsBotModalOpen).toBe('function');
      expect(typeof result.current.setIsTermsModalOpen).toBe('function');
      expect(typeof result.current.setLoading).toBe('function');
    });
  });

  describe('Persisted Preferences (from UIPreferencesProvider)', () => {
    it('reflects chatbar visibility from preferences', () => {
      vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue({
        ...mockPreferences,
        showChatbar: false,
      });

      const { result } = renderHook(() => useUI());

      expect(result.current.showChatbar).toBe(false);
    });

    it('reflects promptbar visibility from preferences', () => {
      vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue({
        ...mockPreferences,
        showPromptbar: false,
      });

      const { result } = renderHook(() => useUI());

      expect(result.current.showPromptbar).toBe(false);
    });

    it('reflects theme from preferences', () => {
      vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue({
        ...mockPreferences,
        theme: 'dark',
      });

      const { result } = renderHook(() => useUI());

      expect(result.current.theme).toBe('dark');
    });

    it('calls setShowChatbar from preferences', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setShowChatbar(false);
      });

      expect(mockPreferences.setShowChatbar).toHaveBeenCalledWith(false);
    });

    it('calls toggleChatbar from preferences', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.toggleChatbar();
      });

      expect(mockPreferences.toggleChatbar).toHaveBeenCalled();
    });

    it('calls setShowPromptbar from preferences', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setShowPromptbar(false);
      });

      expect(mockPreferences.setShowPromptbar).toHaveBeenCalledWith(false);
    });

    it('calls togglePromptbar from preferences', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.togglePromptbar();
      });

      expect(mockPreferences.togglePromptbar).toHaveBeenCalled();
    });

    it('calls setTheme from preferences', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setTheme('dark');
      });

      expect(mockPreferences.setTheme).toHaveBeenCalledWith('dark');
    });

    it('calls toggleTheme from preferences', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.toggleTheme();
      });

      expect(mockPreferences.toggleTheme).toHaveBeenCalled();
    });
  });

  describe('Ephemeral Modal States (from UIStore)', () => {
    it('reflects settings modal state', () => {
      useUIStore.setState({ isSettingsOpen: true });

      const { result } = renderHook(() => useUI());

      expect(result.current.isSettingsOpen).toBe(true);
    });

    it('reflects bot modal state', () => {
      useUIStore.setState({ isBotModalOpen: true });

      const { result } = renderHook(() => useUI());

      expect(result.current.isBotModalOpen).toBe(true);
    });

    it('reflects terms modal state', () => {
      useUIStore.setState({ isTermsModalOpen: true });

      const { result } = renderHook(() => useUI());

      expect(result.current.isTermsModalOpen).toBe(true);
    });

    it('reflects loading state', () => {
      useUIStore.setState({ loading: true });

      const { result } = renderHook(() => useUI());

      expect(result.current.loading).toBe(true);
    });

    it('updates settings modal state', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setIsSettingsOpen(true);
      });

      expect(result.current.isSettingsOpen).toBe(true);
    });

    it('updates bot modal state', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setIsBotModalOpen(true);
      });

      expect(result.current.isBotModalOpen).toBe(true);
    });

    it('updates terms modal state', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setIsTermsModalOpen(true);
      });

      expect(result.current.isTermsModalOpen).toBe(true);
    });

    it('updates loading state', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setLoading(true);
      });

      expect(result.current.loading).toBe(true);
    });

    it('can toggle modal states', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setIsSettingsOpen(true);
      });
      expect(result.current.isSettingsOpen).toBe(true);

      act(() => {
        result.current.setIsSettingsOpen(false);
      });
      expect(result.current.isSettingsOpen).toBe(false);
    });
  });

  describe('Combined State Management', () => {
    it('manages both preference and modal states independently', () => {
      vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue({
        ...mockPreferences,
        showChatbar: false,
        theme: 'dark',
      });

      useUIStore.setState({
        isSettingsOpen: true,
        isBotModalOpen: true,
      });

      const { result } = renderHook(() => useUI());

      // Preferences
      expect(result.current.showChatbar).toBe(false);
      expect(result.current.theme).toBe('dark');

      // Modals
      expect(result.current.isSettingsOpen).toBe(true);
      expect(result.current.isBotModalOpen).toBe(true);
    });

    it('can update both types of state in same workflow', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        // Update preference
        result.current.setShowChatbar(false);
        // Update modal state
        result.current.setIsSettingsOpen(true);
      });

      expect(mockPreferences.setShowChatbar).toHaveBeenCalledWith(false);
      expect(result.current.isSettingsOpen).toBe(true);
    });

    it('handles multiple modal states open simultaneously', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setIsSettingsOpen(true);
        result.current.setIsBotModalOpen(true);
        result.current.setIsTermsModalOpen(true);
      });

      expect(result.current.isSettingsOpen).toBe(true);
      expect(result.current.isBotModalOpen).toBe(true);
      expect(result.current.isTermsModalOpen).toBe(true);
    });

    it('loading state is independent of modal states', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setLoading(true);
        result.current.setIsSettingsOpen(true);
      });

      expect(result.current.loading).toBe(true);
      expect(result.current.isSettingsOpen).toBe(true);
    });
  });

  describe('Integration', () => {
    it('shares modal state across multiple hook instances', () => {
      const { result: result1 } = renderHook(() => useUI());
      const { result: result2 } = renderHook(() => useUI());

      act(() => {
        result1.current.setIsSettingsOpen(true);
      });

      expect(result2.current.isSettingsOpen).toBe(true);
    });

    it('reflects changes made directly to UI store', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        useUIStore.getState().setIsBotModalOpen(true);
      });

      expect(result.current.isBotModalOpen).toBe(true);
    });

    it('updates are visible across all instances', () => {
      const { result: result1 } = renderHook(() => useUI());
      const { result: result2 } = renderHook(() => useUI());

      act(() => {
        result1.current.setLoading(true);
      });

      expect(result2.current.loading).toBe(true);
    });
  });

  describe('Theme Management', () => {
    it('handles light theme', () => {
      vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue({
        ...mockPreferences,
        theme: 'light',
      });

      const { result } = renderHook(() => useUI());

      expect(result.current.theme).toBe('light');
    });

    it('handles dark theme', () => {
      vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue({
        ...mockPreferences,
        theme: 'dark',
      });

      const { result } = renderHook(() => useUI());

      expect(result.current.theme).toBe('dark');
    });

    it('can switch themes', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.setTheme('dark');
      });

      expect(mockPreferences.setTheme).toHaveBeenCalledWith('dark');
    });

    it('can toggle themes', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.toggleTheme();
      });

      expect(mockPreferences.toggleTheme).toHaveBeenCalled();
    });
  });

  describe('Sidebar Management', () => {
    it('manages chatbar visibility', () => {
      vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue({
        ...mockPreferences,
        showChatbar: true,
      });

      const { result } = renderHook(() => useUI());

      expect(result.current.showChatbar).toBe(true);

      act(() => {
        result.current.setShowChatbar(false);
      });

      expect(mockPreferences.setShowChatbar).toHaveBeenCalledWith(false);
    });

    it('manages promptbar visibility', () => {
      vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue({
        ...mockPreferences,
        showPromptbar: true,
      });

      const { result } = renderHook(() => useUI());

      expect(result.current.showPromptbar).toBe(true);

      act(() => {
        result.current.setShowPromptbar(false);
      });

      expect(mockPreferences.setShowPromptbar).toHaveBeenCalledWith(false);
    });

    it('can toggle chatbar', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.toggleChatbar();
      });

      expect(mockPreferences.toggleChatbar).toHaveBeenCalled();
    });

    it('can toggle promptbar', () => {
      const { result } = renderHook(() => useUI());

      act(() => {
        result.current.togglePromptbar();
      });

      expect(mockPreferences.togglePromptbar).toHaveBeenCalled();
    });

    it('handles both sidebars hidden', () => {
      vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue({
        ...mockPreferences,
        showChatbar: false,
        showPromptbar: false,
      });

      const { result } = renderHook(() => useUI());

      expect(result.current.showChatbar).toBe(false);
      expect(result.current.showPromptbar).toBe(false);
    });

    it('handles both sidebars visible', () => {
      vi.mocked(UIPreferencesProvider.useUIPreferences).mockReturnValue({
        ...mockPreferences,
        showChatbar: true,
        showPromptbar: true,
      });

      const { result } = renderHook(() => useUI());

      expect(result.current.showChatbar).toBe(true);
      expect(result.current.showPromptbar).toBe(true);
    });
  });
});
