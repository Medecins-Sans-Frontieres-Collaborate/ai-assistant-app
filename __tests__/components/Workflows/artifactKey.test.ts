/**
 * Artifact identity per workflow type (docs/WORKFLOW_EMISSIONS_DESIGN.md §7c).
 *
 * The rule that matters most: keys come from IDENTITY-defining fields only.
 * Keying off content would churn the key on every edit and shatter one
 * artifact's spend into fragments.
 */
import { WorkflowState } from '@/types/workflow';

import { artifactOf } from '@/components/Workflows/artifactKey';

import { describe, expect, it } from 'vitest';

const translation = (over: Partial<never> = {}): WorkflowState =>
  ({
    kind: 'translation',
    sourceText: 'Hello',
    mode: 'quick',
    rounds: [],
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...over,
  }) as WorkflowState;

describe('artifactOf', () => {
  it('keys a translation by its target language, and labels it', () => {
    const state = translation({
      targetLanguage: { id: 'ps', label: 'Pashto (پښتو)' },
    } as never);
    expect(artifactOf(state)).toEqual({
      id: 'lang:ps',
      label: 'Pashto (پښتو)',
    });
  });

  it('keeps the same artifact when only the source text changes', () => {
    const target = { id: 'fr', label: 'French' };
    const before = artifactOf(translation({ targetLanguage: target } as never));
    const after = artifactOf(
      translation({
        targetLanguage: target,
        sourceText: 'Hello, world — with a typo fixed',
      } as never),
    );
    expect(after.id).toBe(before.id);
  });

  it('changes artifact when the target language changes', () => {
    const fr = artifactOf(
      translation({ targetLanguage: { id: 'fr', label: 'French' } } as never),
    );
    const ps = artifactOf(
      translation({ targetLanguage: { id: 'ps', label: 'Pashto' } } as never),
    );
    expect(ps.id).not.toBe(fr.id);
  });

  it('keys a map by the most recently loaded dataset', () => {
    const state = {
      kind: 'map',
      features: [],
      sources: [
        {
          id: '1',
          name: 'Old',
          addedAt: '',
          featureCount: 0,
          kind: 'dataset',
          datasetId: 'd1',
        },
        {
          id: '2',
          name: 'Sahel 2026',
          addedAt: '',
          featureCount: 0,
          kind: 'dataset',
          datasetId: 'd2',
        },
      ],
      updatedAt: '',
    } as unknown as WorkflowState;
    expect(artifactOf(state)).toEqual({
      id: 'dataset:d2',
      label: 'Sahel 2026',
    });
  });

  it('treats a hand-built map as one workspace-long artifact', () => {
    const state = {
      kind: 'map',
      features: [],
      sources: [
        { id: '1', name: 'Pasted', addedAt: '', featureCount: 3, kind: 'text' },
      ],
      updatedAt: '',
    } as unknown as WorkflowState;
    expect(artifactOf(state).id).toBe('workspace');
  });

  it('keys a document by its M365 binding when bound', () => {
    const state = {
      kind: 'document',
      title: 'Report',
      docHtml: '',
      references: [],
      revisions: [],
      m365Binding: { itemId: 'item-9', fileName: 'Report.docx' },
      updatedAt: '',
    } as unknown as WorkflowState;
    expect(artifactOf(state)).toEqual({
      id: 'm365:item-9',
      label: 'Report.docx',
    });
  });

  it('treats a data table as the workspace — it mutates, it never becomes another table', () => {
    const state = {
      kind: 'data-analysis',
      columns: [],
      rows: [],
      sources: [],
      operations: [],
      updatedAt: '',
    } as unknown as WorkflowState;
    expect(artifactOf(state).id).toBe('workspace');
  });

  it('never throws on an absent state', () => {
    expect(artifactOf(undefined).id).toBe('workspace');
  });
});
