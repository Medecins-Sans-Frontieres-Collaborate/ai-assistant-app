import { act, renderHook } from '@testing-library/react';

import { useTones } from '@/client/hooks/settings/useTones';

import type { Tone } from '@/types/tone';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('useTones', () => {
  beforeEach(() => {
    // Reset the store to initial state before each test
    useSettingsStore.setState({
      tones: [],
    });
  });

  const createMockTone = (overrides?: Partial<Tone>): Tone => ({
    id: 'tone-1',
    name: 'Professional',
    description: 'Formal business tone',
    voiceRules: 'Use formal language, avoid contractions',
    examples: 'Example: "I am writing to inform you..."',
    tags: ['business', 'formal'],
    createdAt: new Date().toISOString(),
    folderId: null,
    ...overrides,
  });

  describe('Initial State', () => {
    it('returns empty array when no tones exist', () => {
      const { result } = renderHook(() => useTones());

      expect(result.current.tones).toEqual([]);
    });

    it('returns all functions', () => {
      const { result } = renderHook(() => useTones());

      expect(typeof result.current.addTone).toBe('function');
      expect(typeof result.current.updateTone).toBe('function');
      expect(typeof result.current.deleteTone).toBe('function');
      expect(typeof result.current.setTones).toBe('function');
    });

    it('returns existing tones from store', () => {
      const existingTones = [
        createMockTone({ id: 'tone-1', name: 'Professional' }),
        createMockTone({ id: 'tone-2', name: 'Casual' }),
      ];

      useSettingsStore.setState({ tones: existingTones });

      const { result } = renderHook(() => useTones());

      expect(result.current.tones).toHaveLength(2);
      expect(result.current.tones).toEqual(existingTones);
    });
  });

  describe('addTone', () => {
    it('adds a new tone to empty list', () => {
      const { result } = renderHook(() => useTones());

      const newTone = createMockTone();

      act(() => {
        result.current.addTone(newTone);
      });

      expect(result.current.tones).toHaveLength(1);
      expect(result.current.tones[0]).toEqual(newTone);
    });

    it('adds a new tone to existing list', () => {
      const existingTone = createMockTone({
        id: 'tone-1',
        name: 'Professional',
      });
      useSettingsStore.setState({ tones: [existingTone] });

      const { result } = renderHook(() => useTones());

      const newTone = createMockTone({ id: 'tone-2', name: 'Casual' });

      act(() => {
        result.current.addTone(newTone);
      });

      expect(result.current.tones).toHaveLength(2);
      expect(result.current.tones[0]).toEqual(existingTone);
      expect(result.current.tones[1]).toEqual(newTone);
    });

    it('preserves all tone properties', () => {
      const { result } = renderHook(() => useTones());

      const tone: Tone = {
        id: 'test-id',
        name: 'Technical',
        description: 'Technical writing style',
        voiceRules: 'Use precise terminology, avoid ambiguity',
        examples: 'Example: "The function returns..."',
        tags: ['technical', 'programming'],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
        folderId: 'folder-123',
      };

      act(() => {
        result.current.addTone(tone);
      });

      expect(result.current.tones[0]).toEqual(tone);
    });

    it('handles tones without optional fields', () => {
      const { result } = renderHook(() => useTones());

      const tone: Tone = {
        id: 'minimal',
        name: 'Minimal Tone',
        description: 'Bare minimum',
        voiceRules: 'Be brief',
        createdAt: '2024-01-01T00:00:00.000Z',
        folderId: null,
      };

      act(() => {
        result.current.addTone(tone);
      });

      expect(result.current.tones[0]).toEqual(tone);
      expect(result.current.tones[0].examples).toBeUndefined();
      expect(result.current.tones[0].tags).toBeUndefined();
      expect(result.current.tones[0].updatedAt).toBeUndefined();
    });

    it('adds multiple tones sequentially', () => {
      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.addTone(createMockTone({ id: 'tone-1', name: 'First' }));
        result.current.addTone(
          createMockTone({ id: 'tone-2', name: 'Second' }),
        );
        result.current.addTone(createMockTone({ id: 'tone-3', name: 'Third' }));
      });

      expect(result.current.tones).toHaveLength(3);
    });
  });

  describe('updateTone', () => {
    it('updates tone name', () => {
      const tone = createMockTone({ id: 'tone-1', name: 'Original' });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.updateTone('tone-1', { name: 'Updated' });
      });

      expect(result.current.tones[0].name).toBe('Updated');
    });

    it('updates tone description', () => {
      const tone = createMockTone({
        id: 'tone-1',
        description: 'Original desc',
      });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.updateTone('tone-1', {
          description: 'Updated description',
        });
      });

      expect(result.current.tones[0].description).toBe('Updated description');
    });

    it('updates voice rules', () => {
      const tone = createMockTone({
        id: 'tone-1',
        voiceRules: 'Original rules',
      });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.updateTone('tone-1', { voiceRules: 'New rules' });
      });

      expect(result.current.tones[0].voiceRules).toBe('New rules');
    });

    it('updates tags', () => {
      const tone = createMockTone({ id: 'tone-1', tags: ['old-tag'] });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.updateTone('tone-1', {
          tags: ['new-tag-1', 'new-tag-2'],
        });
      });

      expect(result.current.tones[0].tags).toEqual(['new-tag-1', 'new-tag-2']);
    });

    it('updates multiple fields at once', () => {
      const tone = createMockTone({
        id: 'tone-1',
        name: 'Original',
        description: 'Original desc',
        voiceRules: 'Original rules',
      });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.updateTone('tone-1', {
          name: 'New Name',
          description: 'New description',
          voiceRules: 'New rules',
        });
      });

      expect(result.current.tones[0].name).toBe('New Name');
      expect(result.current.tones[0].description).toBe('New description');
      expect(result.current.tones[0].voiceRules).toBe('New rules');
    });

    it('preserves unchanged fields', () => {
      const tone = createMockTone({
        id: 'tone-1',
        name: 'Original',
        voiceRules: 'Original rules',
        tags: ['tag1', 'tag2'],
      });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.updateTone('tone-1', { name: 'Updated' });
      });

      expect(result.current.tones[0].voiceRules).toBe('Original rules');
      expect(result.current.tones[0].tags).toEqual(['tag1', 'tag2']);
    });

    it('only updates the specified tone', () => {
      const tones = [
        createMockTone({ id: 'tone-1', name: 'First' }),
        createMockTone({ id: 'tone-2', name: 'Second' }),
        createMockTone({ id: 'tone-3', name: 'Third' }),
      ];
      useSettingsStore.setState({ tones });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.updateTone('tone-2', { name: 'Updated Second' });
      });

      expect(result.current.tones[0].name).toBe('First');
      expect(result.current.tones[1].name).toBe('Updated Second');
      expect(result.current.tones[2].name).toBe('Third');
    });

    it('does nothing if tone ID not found', () => {
      const tone = createMockTone({ id: 'tone-1', name: 'Original' });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.updateTone('non-existent', { name: 'Updated' });
      });

      expect(result.current.tones[0].name).toBe('Original');
    });

    it('updates folderId', () => {
      const tone = createMockTone({ id: 'tone-1', folderId: null });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.updateTone('tone-1', { folderId: 'folder-123' });
      });

      expect(result.current.tones[0].folderId).toBe('folder-123');
    });

    it('can set folderId back to null', () => {
      const tone = createMockTone({ id: 'tone-1', folderId: 'folder-123' });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.updateTone('tone-1', { folderId: null });
      });

      expect(result.current.tones[0].folderId).toBeNull();
    });
  });

  describe('deleteTone', () => {
    it('deletes a tone by id', () => {
      const tone = createMockTone({ id: 'tone-1' });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.deleteTone('tone-1');
      });

      expect(result.current.tones).toHaveLength(0);
    });

    it('deletes correct tone from multiple tones', () => {
      const tones = [
        createMockTone({ id: 'tone-1', name: 'First' }),
        createMockTone({ id: 'tone-2', name: 'Second' }),
        createMockTone({ id: 'tone-3', name: 'Third' }),
      ];
      useSettingsStore.setState({ tones });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.deleteTone('tone-2');
      });

      expect(result.current.tones).toHaveLength(2);
      expect(result.current.tones[0].id).toBe('tone-1');
      expect(result.current.tones[1].id).toBe('tone-3');
    });

    it('does nothing if tone ID not found', () => {
      const tone = createMockTone({ id: 'tone-1' });
      useSettingsStore.setState({ tones: [tone] });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.deleteTone('non-existent');
      });

      expect(result.current.tones).toHaveLength(1);
    });

    it('handles deleting from empty list', () => {
      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.deleteTone('tone-1');
      });

      expect(result.current.tones).toHaveLength(0);
    });

    it('can delete multiple tones sequentially', () => {
      const tones = [
        createMockTone({ id: 'tone-1', name: 'First' }),
        createMockTone({ id: 'tone-2', name: 'Second' }),
        createMockTone({ id: 'tone-3', name: 'Third' }),
      ];
      useSettingsStore.setState({ tones });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.deleteTone('tone-1');
        result.current.deleteTone('tone-3');
      });

      expect(result.current.tones).toHaveLength(1);
      expect(result.current.tones[0].id).toBe('tone-2');
    });
  });

  describe('setTones', () => {
    it('sets tones from empty state', () => {
      const { result } = renderHook(() => useTones());

      const tones = [
        createMockTone({ id: 'tone-1', name: 'First' }),
        createMockTone({ id: 'tone-2', name: 'Second' }),
      ];

      act(() => {
        result.current.setTones(tones);
      });

      expect(result.current.tones).toHaveLength(2);
      expect(result.current.tones).toEqual(tones);
    });

    it('replaces existing tones', () => {
      const existingTones = [createMockTone({ id: 'old-1', name: 'Old' })];
      useSettingsStore.setState({ tones: existingTones });

      const { result } = renderHook(() => useTones());

      const newTones = [
        createMockTone({ id: 'new-1', name: 'New First' }),
        createMockTone({ id: 'new-2', name: 'New Second' }),
      ];

      act(() => {
        result.current.setTones(newTones);
      });

      expect(result.current.tones).toHaveLength(2);
      expect(result.current.tones).toEqual(newTones);
    });

    it('can set to empty array', () => {
      const existingTones = [
        createMockTone({ id: 'tone-1', name: 'First' }),
        createMockTone({ id: 'tone-2', name: 'Second' }),
      ];
      useSettingsStore.setState({ tones: existingTones });

      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.setTones([]);
      });

      expect(result.current.tones).toHaveLength(0);
    });

    it('useful for bulk import', () => {
      const { result } = renderHook(() => useTones());

      const importedTones = [
        createMockTone({ id: 'import-1', name: 'Imported 1' }),
        createMockTone({ id: 'import-2', name: 'Imported 2' }),
        createMockTone({ id: 'import-3', name: 'Imported 3' }),
      ];

      act(() => {
        result.current.setTones(importedTones);
      });

      expect(result.current.tones).toEqual(importedTones);
    });
  });

  describe('Integration with Store', () => {
    it('reflects changes made directly to store', () => {
      const { result } = renderHook(() => useTones());

      const tone = createMockTone();

      act(() => {
        useSettingsStore.getState().addTone(tone);
      });

      expect(result.current.tones).toHaveLength(1);
    });

    it('shares state across multiple hook instances', () => {
      const { result: result1 } = renderHook(() => useTones());
      const { result: result2 } = renderHook(() => useTones());

      const tone = createMockTone();

      act(() => {
        result1.current.addTone(tone);
      });

      expect(result2.current.tones).toHaveLength(1);
      expect(result2.current.tones[0]).toEqual(tone);
    });

    it('updates are visible across all instances', () => {
      const tone = createMockTone({ id: 'tone-1', name: 'Original' });
      useSettingsStore.setState({ tones: [tone] });

      const { result: result1 } = renderHook(() => useTones());
      const { result: result2 } = renderHook(() => useTones());

      act(() => {
        result1.current.updateTone('tone-1', { name: 'Updated' });
      });

      expect(result2.current.tones[0].name).toBe('Updated');
    });

    it('deletes are visible across all instances', () => {
      const tones = [
        createMockTone({ id: 'tone-1', name: 'First' }),
        createMockTone({ id: 'tone-2', name: 'Second' }),
      ];
      useSettingsStore.setState({ tones });

      const { result: result1 } = renderHook(() => useTones());
      const { result: result2 } = renderHook(() => useTones());

      act(() => {
        result1.current.deleteTone('tone-1');
      });

      expect(result2.current.tones).toHaveLength(1);
      expect(result2.current.tones[0].id).toBe('tone-2');
    });

    it('setTones is visible across all instances', () => {
      const { result: result1 } = renderHook(() => useTones());
      const { result: result2 } = renderHook(() => useTones());

      const newTones = [
        createMockTone({ id: 'tone-1', name: 'First' }),
        createMockTone({ id: 'tone-2', name: 'Second' }),
      ];

      act(() => {
        result1.current.setTones(newTones);
      });

      expect(result2.current.tones).toEqual(newTones);
    });
  });

  describe('Complex Workflows', () => {
    it('handles full CRUD cycle', () => {
      const { result } = renderHook(() => useTones());

      // Create
      const tone = createMockTone({ id: 'tone-1', name: 'Test Tone' });
      act(() => {
        result.current.addTone(tone);
      });
      expect(result.current.tones).toHaveLength(1);

      // Update
      act(() => {
        result.current.updateTone('tone-1', { name: 'Updated Tone' });
      });
      expect(result.current.tones[0].name).toBe('Updated Tone');

      // Delete
      act(() => {
        result.current.deleteTone('tone-1');
      });
      expect(result.current.tones).toHaveLength(0);
    });

    it('handles organizing tones into folders', () => {
      const { result } = renderHook(() => useTones());

      // Add tones without folders
      act(() => {
        result.current.addTone(
          createMockTone({ id: 'tone-1', name: 'First', folderId: null }),
        );
        result.current.addTone(
          createMockTone({ id: 'tone-2', name: 'Second', folderId: null }),
        );
      });

      // Move to folder
      act(() => {
        result.current.updateTone('tone-1', { folderId: 'folder-123' });
      });

      expect(result.current.tones[0].folderId).toBe('folder-123');
      expect(result.current.tones[1].folderId).toBeNull();
    });

    it('handles bulk replacement with setTones', () => {
      const { result } = renderHook(() => useTones());

      // Initial setup
      act(() => {
        result.current.addTone(createMockTone({ id: 'old-1', name: 'Old' }));
      });

      // Bulk replace (like import)
      const importedTones = [
        createMockTone({ id: 'new-1', name: 'New 1' }),
        createMockTone({ id: 'new-2', name: 'New 2' }),
        createMockTone({ id: 'new-3', name: 'New 3' }),
      ];

      act(() => {
        result.current.setTones(importedTones);
      });

      expect(result.current.tones).toHaveLength(3);
      expect(result.current.tones).toEqual(importedTones);
    });

    it('handles managing tones with different tags', () => {
      const { result } = renderHook(() => useTones());

      act(() => {
        result.current.addTone(
          createMockTone({
            id: 'tone-1',
            name: 'Professional',
            tags: ['business', 'formal'],
          }),
        );
        result.current.addTone(
          createMockTone({
            id: 'tone-2',
            name: 'Casual',
            tags: ['friendly', 'informal'],
          }),
        );
      });

      expect(result.current.tones[0].tags).toEqual(['business', 'formal']);
      expect(result.current.tones[1].tags).toEqual(['friendly', 'informal']);

      // Update tags
      act(() => {
        result.current.updateTone('tone-1', {
          tags: ['business', 'formal', 'corporate'],
        });
      });

      expect(result.current.tones[0].tags).toEqual([
        'business',
        'formal',
        'corporate',
      ]);
    });
  });
});
