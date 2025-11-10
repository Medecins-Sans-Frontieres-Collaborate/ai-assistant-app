import { act, renderHook } from '@testing-library/react';

import { useModalForm } from '@/client/hooks/ui/useModalForm';

import { describe, expect, it } from 'vitest';

describe('useModalForm', () => {
  interface TestFormData {
    name: string;
    description: string;
    tags?: string[];
    isActive?: boolean;
  }

  const initialState: TestFormData = {
    name: '',
    description: '',
    tags: [],
    isActive: true,
  };

  describe('Initial State', () => {
    it('initializes with closed modal', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      expect(result.current.isOpen).toBe(false);
    });

    it('initializes with initial form data', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      expect(result.current.formData).toEqual(initialState);
    });

    it('initializes with null item ID', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      expect(result.current.itemId).toBeNull();
    });

    it('initializes with all required functions', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      expect(typeof result.current.openNew).toBe('function');
      expect(typeof result.current.openEdit).toBe('function');
      expect(typeof result.current.close).toBe('function');
      expect(typeof result.current.updateField).toBe('function');
      expect(typeof result.current.setFormData).toBe('function');
      expect(typeof result.current.reset).toBe('function');
    });
  });

  describe('Opening for New Item', () => {
    it('opens modal when openNew is called', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openNew();
      });

      expect(result.current.isOpen).toBe(true);
    });

    it('sets form data to initial state', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      // First modify some data
      act(() => {
        result.current.updateField('name', 'Modified');
      });

      // Then open new
      act(() => {
        result.current.openNew();
      });

      expect(result.current.formData).toEqual(initialState);
    });

    it('sets item ID to null', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      // First open for edit
      act(() => {
        result.current.openEdit('test-id', { ...initialState, name: 'Test' });
      });

      // Then open new
      act(() => {
        result.current.openNew();
      });

      expect(result.current.itemId).toBeNull();
    });

    it('resets any previous edits when opening new', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openEdit('test-id', {
          name: 'Existing Item',
          description: 'Some description',
        });
      });

      act(() => {
        result.current.openNew();
      });

      expect(result.current.formData).toEqual(initialState);
      expect(result.current.itemId).toBeNull();
    });
  });

  describe('Opening for Edit', () => {
    it('opens modal when openEdit is called', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      const editData = { name: 'Test Item', description: 'Test Description' };

      act(() => {
        result.current.openEdit('item-123', editData);
      });

      expect(result.current.isOpen).toBe(true);
    });

    it('sets form data to provided data', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      const editData = {
        name: 'Test Item',
        description: 'Test Description',
        tags: ['tag1', 'tag2'],
      };

      act(() => {
        result.current.openEdit('item-123', editData);
      });

      expect(result.current.formData).toEqual(editData);
    });

    it('sets item ID to provided ID', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openEdit('item-456', { name: 'Test', description: '' });
      });

      expect(result.current.itemId).toBe('item-456');
    });

    it('handles opening edit multiple times with different data', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openEdit('item-1', {
          name: 'First',
          description: 'First item',
        });
      });

      expect(result.current.itemId).toBe('item-1');
      expect(result.current.formData.name).toBe('First');

      act(() => {
        result.current.openEdit('item-2', {
          name: 'Second',
          description: 'Second item',
        });
      });

      expect(result.current.itemId).toBe('item-2');
      expect(result.current.formData.name).toBe('Second');
    });
  });

  describe('Closing Modal', () => {
    it('closes modal when close is called', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openNew();
      });

      act(() => {
        result.current.close();
      });

      expect(result.current.isOpen).toBe(false);
    });

    it('resets form data to initial state on close', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openEdit('item-1', {
          name: 'Modified',
          description: 'Modified desc',
        });
      });

      act(() => {
        result.current.close();
      });

      expect(result.current.formData).toEqual(initialState);
    });

    it('resets item ID to null on close', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openEdit('item-1', { name: 'Test', description: '' });
      });

      act(() => {
        result.current.close();
      });

      expect(result.current.itemId).toBeNull();
    });

    it('can reopen modal after closing', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openNew();
      });

      act(() => {
        result.current.close();
      });

      act(() => {
        result.current.openNew();
      });

      expect(result.current.isOpen).toBe(true);
      expect(result.current.formData).toEqual(initialState);
    });
  });

  describe('Updating Fields', () => {
    it('updates a single field', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.updateField('name', 'Updated Name');
      });

      expect(result.current.formData.name).toBe('Updated Name');
    });

    it('preserves other fields when updating one field', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.updateField('name', 'New Name');
      });

      expect(result.current.formData.description).toBe(
        initialState.description,
      );
      expect(result.current.formData.tags).toEqual(initialState.tags);
    });

    it('updates multiple fields sequentially', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.updateField('name', 'Test Name');
        result.current.updateField('description', 'Test Description');
        result.current.updateField('isActive', false);
      });

      expect(result.current.formData).toEqual({
        name: 'Test Name',
        description: 'Test Description',
        tags: [],
        isActive: false,
      });
    });

    it('handles updating array fields', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      const newTags = ['tag1', 'tag2', 'tag3'];

      act(() => {
        result.current.updateField('tags', newTags);
      });

      expect(result.current.formData.tags).toEqual(newTags);
    });

    it('handles updating optional fields', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.updateField('isActive', undefined);
      });

      expect(result.current.formData.isActive).toBeUndefined();
    });
  });

  describe('Setting Form Data', () => {
    it('replaces entire form data', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      const newData: TestFormData = {
        name: 'Complete New Data',
        description: 'Completely replaced',
        tags: ['new-tag'],
        isActive: false,
      };

      act(() => {
        result.current.setFormData(newData);
      });

      expect(result.current.formData).toEqual(newData);
    });

    it('overwrites previous updates', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.updateField('name', 'First Update');
        result.current.updateField('description', 'Some description');
      });

      const completeReplace: TestFormData = {
        name: 'Replaced',
        description: 'All new',
      };

      act(() => {
        result.current.setFormData(completeReplace);
      });

      expect(result.current.formData).toEqual(completeReplace);
    });

    it('can be used to partially populate form', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      const partialData: TestFormData = {
        name: 'Partial',
        description: '',
      };

      act(() => {
        result.current.setFormData(partialData);
      });

      expect(result.current.formData).toEqual(partialData);
    });
  });

  describe('Reset', () => {
    it('resets form data to initial state', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.updateField('name', 'Modified');
        result.current.updateField('description', 'Modified desc');
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.formData).toEqual(initialState);
    });

    it('resets item ID to null', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openEdit('item-1', { name: 'Test', description: '' });
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.itemId).toBeNull();
    });

    it('does not close the modal', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openNew();
      });

      act(() => {
        result.current.updateField('name', 'Modified');
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.isOpen).toBe(true);
      expect(result.current.formData).toEqual(initialState);
    });

    it('can be used to clear form without closing', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openEdit('item-1', {
          name: 'Existing',
          description: 'Existing desc',
        });
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.isOpen).toBe(true);
      expect(result.current.formData).toEqual(initialState);
      expect(result.current.itemId).toBeNull();
    });
  });

  describe('Callback Stability', () => {
    it('maintains stable reference for openNew', () => {
      const { result, rerender } = renderHook(() =>
        useModalForm({ initialState }),
      );

      const firstOpenNew = result.current.openNew;

      rerender();

      expect(result.current.openNew).toBe(firstOpenNew);
    });

    it('maintains stable reference for openEdit', () => {
      const { result, rerender } = renderHook(() =>
        useModalForm({ initialState }),
      );

      const firstOpenEdit = result.current.openEdit;

      rerender();

      expect(result.current.openEdit).toBe(firstOpenEdit);
    });

    it('maintains stable reference for close', () => {
      const { result, rerender } = renderHook(() =>
        useModalForm({ initialState }),
      );

      const firstClose = result.current.close;

      rerender();

      expect(result.current.close).toBe(firstClose);
    });

    it('maintains stable reference for updateField', () => {
      const { result, rerender } = renderHook(() =>
        useModalForm({ initialState }),
      );

      const firstUpdateField = result.current.updateField;

      rerender();

      expect(result.current.updateField).toBe(firstUpdateField);
    });

    it('maintains stable reference for setFormData', () => {
      const { result, rerender } = renderHook(() =>
        useModalForm({ initialState }),
      );

      const firstSetFormData = result.current.setFormData;

      rerender();

      expect(result.current.setFormData).toBe(firstSetFormData);
    });

    it('maintains stable reference for reset', () => {
      const { result, rerender } = renderHook(() =>
        useModalForm({ initialState }),
      );

      const firstReset = result.current.reset;

      rerender();

      expect(result.current.reset).toBe(firstReset);
    });
  });

  describe('Complex Scenarios', () => {
    it('handles full create workflow', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      // Open for new
      act(() => {
        result.current.openNew();
      });

      expect(result.current.isOpen).toBe(true);
      expect(result.current.itemId).toBeNull();

      // Fill in form
      act(() => {
        result.current.updateField('name', 'New Item');
        result.current.updateField('description', 'Created from scratch');
      });

      expect(result.current.formData.name).toBe('New Item');

      // Close (simulating save)
      act(() => {
        result.current.close();
      });

      expect(result.current.isOpen).toBe(false);
      expect(result.current.formData).toEqual(initialState);
    });

    it('handles full edit workflow', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      const existingData: TestFormData = {
        name: 'Existing Item',
        description: 'Original description',
        tags: ['original'],
        isActive: true,
      };

      // Open for edit
      act(() => {
        result.current.openEdit('item-123', existingData);
      });

      expect(result.current.isOpen).toBe(true);
      expect(result.current.itemId).toBe('item-123');
      expect(result.current.formData).toEqual(existingData);

      // Modify fields
      act(() => {
        result.current.updateField('description', 'Updated description');
        result.current.updateField('isActive', false);
      });

      expect(result.current.formData).toEqual({
        name: 'Existing Item',
        description: 'Updated description',
        tags: ['original'],
        isActive: false,
      });

      // Close (simulating save)
      act(() => {
        result.current.close();
      });

      expect(result.current.isOpen).toBe(false);
      expect(result.current.formData).toEqual(initialState);
    });

    it('handles canceling edit and reopening for new', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      // Open for edit
      act(() => {
        result.current.openEdit('item-1', {
          name: 'Editing',
          description: 'In progress',
        });
      });

      // Make some changes
      act(() => {
        result.current.updateField('description', 'Modified');
      });

      // Cancel (close)
      act(() => {
        result.current.close();
      });

      // Open for new item
      act(() => {
        result.current.openNew();
      });

      expect(result.current.isOpen).toBe(true);
      expect(result.current.itemId).toBeNull();
      expect(result.current.formData).toEqual(initialState);
    });

    it('handles switching between edit items without closing', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      // Edit first item
      act(() => {
        result.current.openEdit('item-1', {
          name: 'First',
          description: 'First item',
        });
      });

      expect(result.current.itemId).toBe('item-1');

      // Edit second item directly
      act(() => {
        result.current.openEdit('item-2', {
          name: 'Second',
          description: 'Second item',
        });
      });

      expect(result.current.itemId).toBe('item-2');
      expect(result.current.formData.name).toBe('Second');
      expect(result.current.isOpen).toBe(true);
    });

    it('handles reset during edit mode', () => {
      const { result } = renderHook(() => useModalForm({ initialState }));

      act(() => {
        result.current.openEdit('item-1', {
          name: 'Original',
          description: 'Original desc',
        });
      });

      act(() => {
        result.current.updateField('name', 'Modified');
      });

      // Reset clears to initial, not to the edit data
      act(() => {
        result.current.reset();
      });

      expect(result.current.formData).toEqual(initialState);
      expect(result.current.itemId).toBeNull();
      expect(result.current.isOpen).toBe(true);
    });
  });

  describe('Different Initial States', () => {
    it('works with different initial state structure', () => {
      interface DifferentFormData {
        title: string;
        count: number;
        enabled: boolean;
      }

      const differentInitial: DifferentFormData = {
        title: 'Default Title',
        count: 0,
        enabled: false,
      };

      const { result } = renderHook(() =>
        useModalForm({ initialState: differentInitial }),
      );

      expect(result.current.formData).toEqual(differentInitial);

      act(() => {
        result.current.updateField('count', 42);
        result.current.updateField('enabled', true);
      });

      expect(result.current.formData).toEqual({
        title: 'Default Title',
        count: 42,
        enabled: true,
      });
    });

    it('works with empty object as initial state', () => {
      const emptyInitial = {};

      const { result } = renderHook(() =>
        useModalForm({ initialState: emptyInitial }),
      );

      expect(result.current.formData).toEqual({});
    });
  });
});
