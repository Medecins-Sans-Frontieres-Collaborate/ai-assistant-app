/**
 * What "the artifact" is, per workflow type
 * (docs/WORKFLOW_EMISSIONS_DESIGN.md §7c).
 *
 * The impact readout headlines the current artifact's spend and keeps the
 * workspace total beneath it, so a boundary crossing never reads as data loss.
 * This module answers only the first half: a stable key for whatever the
 * workspace is working on right now.
 *
 * Two rules, both learned the hard way:
 *
 *  1. Key off IDENTITY-defining fields only — a target language, a dataset id,
 *     a binding's item id. Never a content hash: ordinary editing would churn
 *     the key and shatter one artifact's spend into dozens of fragments.
 *  2. Where a workspace genuinely has one artifact for its whole life
 *     (document, data), return a constant. That is not a degenerate case, it
 *     is the correct statement that the workspace IS the artifact — and it
 *     makes the artifact row and the workspace row agree, as they should.
 *
 * Lives beside initialState.ts rather than in registryMeta.ts, which is
 * deliberately leaf-only so the sidebar never pulls workspace code.
 */
import { WorkflowState } from '@/types/workflow';

/** The artifact a run is spent on: a stable key plus a display label. */
export interface WorkflowArtifact {
  id: string;
  /** Human label snapshotted onto the run ("Pashto", "Q3 grants.csv"). */
  label?: string;
}

const WORKSPACE: WorkflowArtifact = { id: 'workspace' };

/**
 * Resolves the current artifact of a workflow state. Never throws: an
 * unrecognized or absent state is one nameless artifact, which keeps a run
 * recordable rather than dropping its spend.
 */
export function artifactOf(state: WorkflowState | undefined): WorkflowArtifact {
  if (!state) return WORKSPACE;
  switch (state.kind) {
    case 'translation': {
      // One source translated into six languages is six artifacts, and the
      // per-language cost is the number a translator actually wants. The
      // source text is deliberately NOT part of the key — fixing a typo in it
      // must not start a new artifact.
      const target = state.targetLanguage;
      if (!target) return { id: 'translation', label: undefined };
      return { id: `lang:${target.id}`, label: target.label };
    }
    case 'map': {
      // Switching the loaded dataset switches the artifact; hand-built maps
      // (no dataset) are one artifact for the workspace's life.
      const dataset = [...state.sources]
        .reverse()
        .find((source) => source.kind === 'dataset' && source.datasetId);
      return dataset?.datasetId
        ? { id: `dataset:${dataset.datasetId}`, label: dataset.name }
        : WORKSPACE;
    }
    case 'document': {
      // A workspace is its document. The one real boundary is rebinding to a
      // different OneDrive/SharePoint file, which makes it a different
      // document by every meaning of the word.
      const binding = state.m365Binding;
      return binding
        ? { id: `m365:${binding.itemId}`, label: binding.fileName }
        : { id: 'document', label: state.title || undefined };
    }
    case 'data-analysis':
      // The table mutates and accretes sources; it never becomes a different
      // table. For data the meaningful split is by ACTION (extract vs
      // transform vs assess), which the readout carries separately.
      return WORKSPACE;
    case 'grants':
      // Telemetry only (§7a) — no ledger, so this is never consulted.
      return WORKSPACE;
    default:
      return WORKSPACE;
  }
}
