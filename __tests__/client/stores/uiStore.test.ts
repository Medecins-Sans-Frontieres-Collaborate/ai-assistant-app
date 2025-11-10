import { useUIStore } from '@/client/stores/uiStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('uiStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      isSettingsOpen: false,
      isBotModalOpen: false,
      isTermsModalOpen: false,
      loading: false,
    });
  });

  describe('Initial State', () => {
    it('has correct initial state', () => {
      const state = useUIStore.getState();

      expect(state.isSettingsOpen).toBe(false);
      expect(state.isBotModalOpen).toBe(false);
      expect(state.isTermsModalOpen).toBe(false);
      expect(state.loading).toBe(false);
    });
  });

  describe('Settings Modal', () => {
    it('opens settings modal', () => {
      useUIStore.getState().setIsSettingsOpen(true);

      expect(useUIStore.getState().isSettingsOpen).toBe(true);
    });

    it('closes settings modal', () => {
      useUIStore.getState().setIsSettingsOpen(true);
      useUIStore.getState().setIsSettingsOpen(false);

      expect(useUIStore.getState().isSettingsOpen).toBe(false);
    });

    it('does not affect other modal states', () => {
      useUIStore.getState().setIsSettingsOpen(true);

      expect(useUIStore.getState().isBotModalOpen).toBe(false);
      expect(useUIStore.getState().isTermsModalOpen).toBe(false);
    });
  });

  describe('Bot Modal', () => {
    it('opens bot modal', () => {
      useUIStore.getState().setIsBotModalOpen(true);

      expect(useUIStore.getState().isBotModalOpen).toBe(true);
    });

    it('closes bot modal', () => {
      useUIStore.getState().setIsBotModalOpen(true);
      useUIStore.getState().setIsBotModalOpen(false);

      expect(useUIStore.getState().isBotModalOpen).toBe(false);
    });

    it('does not affect other modal states', () => {
      useUIStore.getState().setIsBotModalOpen(true);

      expect(useUIStore.getState().isSettingsOpen).toBe(false);
      expect(useUIStore.getState().isTermsModalOpen).toBe(false);
    });
  });

  describe('Terms Modal', () => {
    it('opens terms modal', () => {
      useUIStore.getState().setIsTermsModalOpen(true);

      expect(useUIStore.getState().isTermsModalOpen).toBe(true);
    });

    it('closes terms modal', () => {
      useUIStore.getState().setIsTermsModalOpen(true);
      useUIStore.getState().setIsTermsModalOpen(false);

      expect(useUIStore.getState().isTermsModalOpen).toBe(false);
    });

    it('does not affect other modal states', () => {
      useUIStore.getState().setIsTermsModalOpen(true);

      expect(useUIStore.getState().isSettingsOpen).toBe(false);
      expect(useUIStore.getState().isBotModalOpen).toBe(false);
    });
  });

  describe('Loading State', () => {
    it('sets loading to true', () => {
      useUIStore.getState().setLoading(true);

      expect(useUIStore.getState().loading).toBe(true);
    });

    it('sets loading to false', () => {
      useUIStore.getState().setLoading(true);
      useUIStore.getState().setLoading(false);

      expect(useUIStore.getState().loading).toBe(false);
    });

    it('loading state is independent of modals', () => {
      useUIStore.getState().setLoading(true);

      expect(useUIStore.getState().isSettingsOpen).toBe(false);
      expect(useUIStore.getState().isBotModalOpen).toBe(false);
      expect(useUIStore.getState().isTermsModalOpen).toBe(false);
    });
  });

  describe('Multiple State Changes', () => {
    it('can open multiple modals', () => {
      useUIStore.getState().setIsSettingsOpen(true);
      useUIStore.getState().setIsBotModalOpen(true);
      useUIStore.getState().setIsTermsModalOpen(true);

      expect(useUIStore.getState().isSettingsOpen).toBe(true);
      expect(useUIStore.getState().isBotModalOpen).toBe(true);
      expect(useUIStore.getState().isTermsModalOpen).toBe(true);
    });

    it('can set all states at once', () => {
      useUIStore.setState({
        isSettingsOpen: true,
        isBotModalOpen: true,
        isTermsModalOpen: true,
        loading: true,
      });

      const state = useUIStore.getState();
      expect(state.isSettingsOpen).toBe(true);
      expect(state.isBotModalOpen).toBe(true);
      expect(state.isTermsModalOpen).toBe(true);
      expect(state.loading).toBe(true);
    });
  });

  describe('State Isolation', () => {
    it('changes do not affect subsequent tests', () => {
      useUIStore.getState().setIsSettingsOpen(true);
      useUIStore.getState().setIsBotModalOpen(true);
      useUIStore.getState().setLoading(true);

      // Manually reset (beforeEach also does this)
      useUIStore.setState({
        isSettingsOpen: false,
        isBotModalOpen: false,
        isTermsModalOpen: false,
        loading: false,
      });

      const state = useUIStore.getState();
      expect(state.isSettingsOpen).toBe(false);
      expect(state.isBotModalOpen).toBe(false);
      expect(state.isTermsModalOpen).toBe(false);
      expect(state.loading).toBe(false);
    });
  });

  describe('Action Functions', () => {
    it('setIsSettingsOpen is a function', () => {
      expect(typeof useUIStore.getState().setIsSettingsOpen).toBe('function');
    });

    it('setIsBotModalOpen is a function', () => {
      expect(typeof useUIStore.getState().setIsBotModalOpen).toBe('function');
    });

    it('setIsTermsModalOpen is a function', () => {
      expect(typeof useUIStore.getState().setIsTermsModalOpen).toBe('function');
    });

    it('setLoading is a function', () => {
      expect(typeof useUIStore.getState().setLoading).toBe('function');
    });
  });
});
