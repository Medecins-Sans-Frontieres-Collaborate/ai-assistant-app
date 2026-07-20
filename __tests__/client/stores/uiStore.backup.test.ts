import { useUIStore } from '@/client/stores/uiStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('uiStore backup modal view', () => {
  beforeEach(() => {
    useUIStore.setState({ backupModalView: null });
  });

  it('defaults to null (no backup modal showing)', () => {
    expect(useUIStore.getState().backupModalView).toBeNull();
  });

  it('setBackupModalView sets each view and clears back to null', () => {
    const views = [
      'enroll-intro',
      'enroll-ceremony',
      'enroll-progress',
      'view-key',
      'rotate-confirm',
      'restore',
      'enter-key',
    ] as const;

    for (const view of views) {
      useUIStore.getState().setBackupModalView(view);
      expect(useUIStore.getState().backupModalView).toBe(view);
    }

    useUIStore.getState().setBackupModalView(null);
    expect(useUIStore.getState().backupModalView).toBeNull();
  });

  it('does not disturb unrelated modal state', () => {
    useUIStore.setState({ isSettingsOpen: true });
    useUIStore.getState().setBackupModalView('restore');
    expect(useUIStore.getState().isSettingsOpen).toBe(true);
  });
});
