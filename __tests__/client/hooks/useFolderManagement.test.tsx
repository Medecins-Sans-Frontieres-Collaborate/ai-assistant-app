import { act, renderHook } from '@testing-library/react';

import { useFolderManagement } from '@/client/hooks/ui/useFolderManagement';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock uuid - need to handle both named and default exports
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-123'),
  default: {
    v4: vi.fn(() => 'test-uuid-123'),
  },
}));

// Mock window.confirm
global.confirm = vi.fn();

describe('useFolderManagement', () => {
  interface TestItem {
    id: string;
    name: string;
    folderId?: string | null;
  }

  const mockItems: TestItem[] = [
    { id: '1', name: 'Item 1', folderId: 'folder-1' },
    { id: '2', name: 'Item 2', folderId: 'folder-1' },
    { id: '3', name: 'Item 3', folderId: 'folder-2' },
    { id: '4', name: 'Item 4', folderId: null },
    { id: '5', name: 'Item 5' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial State', () => {
    it('initializes with empty collapsed folders set', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      expect(result.current.collapsedFolders.size).toBe(0);
    });

    it('initializes with null dragOverFolderId', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      expect(result.current.dragOverFolderId).toBeNull();
    });

    it('initializes with isDragging false', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      expect(result.current.isDragging).toBe(false);
    });

    it('initializes with null editing state', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      expect(result.current.editingFolderId).toBeNull();
      expect(result.current.editingFolderName).toBe('');
    });

    it('provides editInputRef', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      expect(result.current.editInputRef).toHaveProperty('current');
    });
  });

  describe('Grouped Items', () => {
    it('groups items by folder', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      expect(result.current.groupedItems.byFolder['folder-1']).toHaveLength(2);
      expect(result.current.groupedItems.byFolder['folder-2']).toHaveLength(1);
    });

    it('separates unfoldered items', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      expect(result.current.groupedItems.unfolderedItems).toHaveLength(2);
    });

    it('handles empty items array', () => {
      const { result } = renderHook(() => useFolderManagement({ items: [] }));

      expect(result.current.groupedItems.byFolder).toEqual({});
      expect(result.current.groupedItems.unfolderedItems).toEqual([]);
    });

    it('updates when items change', () => {
      const { result, rerender } = renderHook(
        ({ items }) => useFolderManagement({ items }),
        { initialProps: { items: mockItems } },
      );

      const newItems: TestItem[] = [
        { id: '1', name: 'Item 1', folderId: 'folder-3' },
      ];

      rerender({ items: newItems });

      expect(result.current.groupedItems.byFolder['folder-3']).toHaveLength(1);
      expect(result.current.groupedItems.byFolder['folder-1']).toBeUndefined();
    });
  });

  describe('Folder Collapse/Expand', () => {
    it('toggles folder collapsed state', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      act(() => {
        result.current.toggleFolder('folder-1');
      });

      expect(result.current.collapsedFolders.has('folder-1')).toBe(true);
    });

    it('toggles folder back to expanded', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      act(() => {
        result.current.toggleFolder('folder-1');
      });

      expect(result.current.collapsedFolders.has('folder-1')).toBe(true);

      act(() => {
        result.current.toggleFolder('folder-1');
      });

      expect(result.current.collapsedFolders.has('folder-1')).toBe(false);
    });

    it('can collapse multiple folders', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      act(() => {
        result.current.toggleFolder('folder-1');
        result.current.toggleFolder('folder-2');
      });

      expect(result.current.collapsedFolders.has('folder-1')).toBe(true);
      expect(result.current.collapsedFolders.has('folder-2')).toBe(true);
    });
  });

  describe('Folder Creation', () => {
    it('creates a new folder with UUID', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );
      const onAdd = vi.fn();

      act(() => {
        result.current.handleCreateFolder('chat', 'New Folder', onAdd);
      });

      expect(onAdd).toHaveBeenCalledWith({
        id: expect.any(String),
        name: 'New Folder',
        type: 'chat',
      });

      // Verify the ID looks like a UUID
      const call = onAdd.mock.calls[0][0];
      expect(call.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('enters edit mode after creating folder', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );
      const onAdd = vi.fn();

      act(() => {
        result.current.handleCreateFolder('prompt', 'New Folder', onAdd);
      });

      // Verify edit mode is active with the generated UUID
      expect(result.current.editingFolderId).toBeTruthy();
      expect(result.current.editingFolderId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(result.current.editingFolderName).toBe('New Folder');
    });
  });

  describe('Folder Renaming', () => {
    it('enters edit mode for folder', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      act(() => {
        result.current.handleRenameFolder('folder-1', 'Current Name');
      });

      expect(result.current.editingFolderId).toBe('folder-1');
      expect(result.current.editingFolderName).toBe('Current Name');
    });

    it('saves folder name', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );
      const onUpdate = vi.fn();

      act(() => {
        result.current.setEditingFolderId('folder-1');
        result.current.setEditingFolderName('Updated Name');
      });

      act(() => {
        result.current.handleSaveFolderName(onUpdate);
      });

      expect(onUpdate).toHaveBeenCalledWith('folder-1', 'Updated Name');
      expect(result.current.editingFolderId).toBeNull();
      expect(result.current.editingFolderName).toBe('');
    });

    it('trims whitespace when saving', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );
      const onUpdate = vi.fn();

      act(() => {
        result.current.setEditingFolderId('folder-1');
        result.current.setEditingFolderName('  Trimmed  ');
      });

      act(() => {
        result.current.handleSaveFolderName(onUpdate);
      });

      expect(onUpdate).toHaveBeenCalledWith('folder-1', 'Trimmed');
    });

    it('does not save empty folder name', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );
      const onUpdate = vi.fn();

      act(() => {
        result.current.setEditingFolderId('folder-1');
        result.current.setEditingFolderName('   ');
      });

      act(() => {
        result.current.handleSaveFolderName(onUpdate);
      });

      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  describe('Folder Deletion', () => {
    it('deletes folder when confirmed', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );
      const onDelete = vi.fn();
      const mockEvent = { stopPropagation: vi.fn() } as any;

      vi.mocked(confirm).mockReturnValue(true);

      act(() => {
        result.current.handleDeleteFolder(
          'folder-1',
          mockEvent,
          onDelete,
          'Are you sure?',
        );
      });

      expect(confirm).toHaveBeenCalledWith('Are you sure?');
      expect(onDelete).toHaveBeenCalledWith('folder-1');
      expect(mockEvent.stopPropagation).toHaveBeenCalled();
    });

    it('does not delete folder when cancelled', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );
      const onDelete = vi.fn();
      const mockEvent = { stopPropagation: vi.fn() } as any;

      vi.mocked(confirm).mockReturnValue(false);

      act(() => {
        result.current.handleDeleteFolder(
          'folder-1',
          mockEvent,
          onDelete,
          'Are you sure?',
        );
      });

      expect(onDelete).not.toHaveBeenCalled();
    });
  });

  describe('Drag and Drop State', () => {
    it('sets dragOverFolderId', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      act(() => {
        result.current.setDragOverFolderId('folder-1');
      });

      expect(result.current.dragOverFolderId).toBe('folder-1');
    });

    it('sets isDragging', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      act(() => {
        result.current.setIsDragging(true);
      });

      expect(result.current.isDragging).toBe(true);
    });

    it('clears dragOverFolderId', () => {
      const { result } = renderHook(() =>
        useFolderManagement({ items: mockItems }),
      );

      act(() => {
        result.current.setDragOverFolderId('folder-1');
      });

      act(() => {
        result.current.setDragOverFolderId(null);
      });

      expect(result.current.dragOverFolderId).toBeNull();
    });
  });
});
