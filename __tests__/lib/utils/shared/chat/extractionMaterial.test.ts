import { getExtractionMaterialState } from '@/lib/utils/shared/chat/extractionMaterial';

import { describe, expect, it } from 'vitest';

describe('getExtractionMaterialState', () => {
  it('returns hasAny=false when every source is empty', () => {
    const state = getExtractionMaterialState({
      textFieldValue: '',
      filePreviewCount: 0,
      activeFileCount: 0,
    });
    expect(state).toEqual({
      hasText: false,
      newFileCount: 0,
      activeFileCount: 0,
      hasAny: false,
    });
  });

  it('treats whitespace-only text as empty', () => {
    const state = getExtractionMaterialState({
      textFieldValue: '   \n\t  ',
      filePreviewCount: 0,
      activeFileCount: 0,
    });
    expect(state.hasText).toBe(false);
    expect(state.hasAny).toBe(false);
  });

  it('flags text-only material', () => {
    const state = getExtractionMaterialState({
      textFieldValue: 'hello',
      filePreviewCount: 0,
      activeFileCount: 0,
    });
    expect(state.hasText).toBe(true);
    expect(state.hasAny).toBe(true);
  });

  it('flags composer files alone', () => {
    const state = getExtractionMaterialState({
      textFieldValue: '',
      filePreviewCount: 2,
      activeFileCount: 0,
    });
    expect(state.newFileCount).toBe(2);
    expect(state.hasAny).toBe(true);
  });

  it('flags active files alone', () => {
    const state = getExtractionMaterialState({
      textFieldValue: '',
      filePreviewCount: 0,
      activeFileCount: 3,
    });
    expect(state.activeFileCount).toBe(3);
    expect(state.hasAny).toBe(true);
  });

  it('combines all sources', () => {
    const state = getExtractionMaterialState({
      textFieldValue: 'extract these patients',
      filePreviewCount: 1,
      activeFileCount: 2,
    });
    expect(state).toEqual({
      hasText: true,
      newFileCount: 1,
      activeFileCount: 2,
      hasAny: true,
    });
  });

  it('clamps negative counts to zero (defensive)', () => {
    const state = getExtractionMaterialState({
      textFieldValue: '',
      filePreviewCount: -5,
      activeFileCount: -1,
    });
    expect(state.newFileCount).toBe(0);
    expect(state.activeFileCount).toBe(0);
    expect(state.hasAny).toBe(false);
  });
});
