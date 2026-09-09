import { useUIStore } from '@/client/stores/uiStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('uiStore — folder view', () => {
  beforeEach(() => {
    useUIStore.setState({ openFolderId: null });
  });

  it('starts with no folder open', () => {
    expect(useUIStore.getState().openFolderId).toBeNull();
  });

  it('opens and closes a folder', () => {
    useUIStore.getState().openFolder('folder-1');
    expect(useUIStore.getState().openFolderId).toBe('folder-1');

    useUIStore.getState().openFolder('folder-2');
    expect(useUIStore.getState().openFolderId).toBe('folder-2');

    useUIStore.getState().closeFolder();
    expect(useUIStore.getState().openFolderId).toBeNull();
  });
});
