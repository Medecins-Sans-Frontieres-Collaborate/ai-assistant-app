import { DOCUMENT_QUALITY_CRITERIA } from '@/lib/utils/shared/document/qualityCriteria';

import {
  DocumentSpec,
  ReviewCriterionRating,
  TranslationEdit,
} from '@/types/workflow';

import { buildAssessmentSchema } from '../shared/assessmentSchema';
import {
  GuidePromptInput,
  buildGuideCriterionBlocks,
  buildStructureGuideBlock,
  buildToneGuideBlock,
  guideRubricLine,
} from '../shared/guidePrompts';
import { callStructured, createAzureClient } from '../shared/workflowLlm';
import {
  ToneInput,
  buildDocAssessmentSystemPrompt,
  buildDocAssessmentUserPrompt,
  buildProfileSystemPrompt,
  buildProfileUserPrompt,
  buildSpecBlock,
  buildToneBlock,
} from './prompts';
import { PROFILE_SCHEMA } from './schemas';

/**
 * Post-hoc quality machinery for the document workflow: an agentic
 * profile (register/tone/audience/purpose/variety) and an MQM-style
 * criterion assessment producing granular edits. Both single strict
 * structured calls; the caller (route) validates inputs.
 */

export interface DocumentProfileResult {
  docType: string;
  audience: string;
  purpose: string;
  register: string;
  toneSummary: string;
  language: string;
  conventionNotes: string;
  notes: string;
}

export async function runDocumentProfile(options: {
  docMarkdown: string;
  modelId?: string;
}): Promise<DocumentProfileResult> {
  const client = createAzureClient();
  return callStructured<DocumentProfileResult>({
    client,
    model: options.modelId,
    system: buildProfileSystemPrompt(),
    user: buildProfileUserPrompt(options.docMarkdown),
    schemaName: 'document_profile',
    schema: PROFILE_SCHEMA as unknown as Record<string, unknown>,
  });
}

/** Edit proposals reuse the translation edit shape (criterion is string). */
export type DocumentEditProposal = Omit<TranslationEdit, 'criterion'> & {
  criterion: string;
};

export interface DocumentAssessmentOptions {
  docMarkdown: string;
  /** Scope the assessment to this excerpt (verbatim substring). */
  selection?: string;
  /** Built-in ids, 'custom:<uuid>' ids, and/or 'guide:<id>' ids. */
  criterionIds: string[];
  /** Definitions for the custom ids (validated by the route). */
  customById: Map<string, { name: string; rubric: string }>;
  /** Resolved criterion-kind guides for the 'guide:' ids (route-resolved). */
  guides?: GuidePromptInput[];
  spec?: DocumentSpec;
  tone?: ToneInput;
  /** Admin structure guide filling the spec slot (exclusive with spec). */
  structureGuide?: GuidePromptInput;
  /** Admin tone guide filling the tone slot (exclusive with tone). */
  toneGuide?: GuidePromptInput;
  /** Profile-detected language/conventions, fed back as context. */
  language?: string;
  conventionNotes?: string;
  modelId?: string;
}

export interface DocumentAssessmentResult {
  criteria: ReviewCriterionRating[];
  overallSummary: string;
  edits: DocumentEditProposal[];
}

interface LlmDocAssessment {
  criteria: Array<{ id: string; rating: number; summary: string }>;
  edits: DocumentEditProposal[];
  overallSummary: string;
}

const MAX_ASSESSMENT_EDITS = 20;

export async function runDocumentAssessment(
  options: DocumentAssessmentOptions,
): Promise<DocumentAssessmentResult> {
  const guidesByCriterionId = new Map(
    (options.guides ?? []).map((g) => [g.criterionId, g]),
  );
  const rubricLines = options.criterionIds.map((id) => {
    const builtin = DOCUMENT_QUALITY_CRITERIA.find((c) => c.id === id);
    if (builtin) return builtin.promptDescription;
    const guide = guidesByCriterionId.get(id);
    if (guide) return guideRubricLine(guide);
    const custom = options.customById.get(id);
    return `${custom?.name ?? id}: ${custom?.rubric ?? ''}`;
  });

  const specBlock = options.spec
    ? buildSpecBlock(options.spec)
    : options.structureGuide
      ? buildStructureGuideBlock(
          options.structureGuide.name,
          options.structureGuide.body,
        )
      : undefined;
  const toneBlock = options.tone
    ? buildToneBlock(options.tone)
    : options.toneGuide
      ? buildToneGuideBlock(options.toneGuide.name, options.toneGuide.body)
      : undefined;

  const client = createAzureClient();
  const result = await callStructured<LlmDocAssessment>({
    client,
    model: options.modelId,
    system: buildDocAssessmentSystemPrompt(rubricLines, {
      specBlock,
      toneBlock,
      guideBlocks: buildGuideCriterionBlocks(options.guides ?? []),
      language: options.language,
      conventionNotes: options.conventionNotes,
      hasSelection: !!options.selection,
    }),
    user: buildDocAssessmentUserPrompt(options.docMarkdown, options.selection),
    schemaName: 'document_assessment',
    schema: buildAssessmentSchema(options.criterionIds),
  });

  const requested = new Set(options.criterionIds);
  const criteria: ReviewCriterionRating[] = result.criteria
    .filter((c) => requested.has(c.id))
    .map((c) => ({
      criterionId: c.id,
      rating: Math.min(Math.max(Math.round(c.rating), 1), 5),
      summary: c.summary,
    }));

  const edits = result.edits
    .filter(
      (e) =>
        requested.has(e.criterion) &&
        typeof e.before === 'string' &&
        e.before.trim() !== '' &&
        e.before !== e.after,
    )
    .slice(0, MAX_ASSESSMENT_EDITS);

  return { criteria, overallSummary: result.overallSummary, edits };
}
