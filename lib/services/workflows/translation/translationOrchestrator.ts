import { criterionRubricLine } from '@/lib/utils/shared/review/customCriteria';
import { computeSegmentChanges } from '@/lib/utils/shared/translation/editApplication';
import { builtinRubricLine } from '@/lib/utils/shared/translation/qualityCriteria';

import {
  GlossaryEntry,
  TranslationAnalysis,
  TranslationCriterionRating,
  TranslationEdit,
  TranslationReviewIssue,
} from '@/types/workflow';

import {
  WorkflowStreamWriter,
  callStreamedText,
  callStructured,
  createAzureClient,
} from '../shared/workflowLlm';
import {
  analysisToNotes,
  buildAnalysisSystemPrompt,
  buildAnalysisUserPrompt,
  buildAssessmentSystemPrompt,
  buildAssessmentUserPrompt,
  buildGlossaryBlock,
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
  buildTranslationSystemPrompt,
  buildTranslationUserPrompt,
} from './prompts';
import {
  ANALYSIS_SCHEMA,
  REVIEW_SCHEMA,
  buildAssessmentSchema,
} from './schemas';

/** Same bounded-rounds discipline as toolLoopCore's MAX_TOOL_ROUNDS. */
export const MAX_REVIEW_ROUNDS = 3;

interface ReviewResult {
  verdict: 'approve' | 'revise';
  issues: TranslationReviewIssue[];
  revisedText: string;
}

export interface TranslationRunOptions {
  sourceText: string;
  targetLanguage: string;
  glossaryEntries: GlossaryEntry[];
  mode: 'quick' | 'agentic';
  maxReviewRounds?: number;
  /** Resolved model id (resolveWorkflowModelId); default when absent. */
  modelId?: string;
  writer: WorkflowStreamWriter;
  signal?: AbortSignal;
}

/**
 * Runs the translation workflow: (agentic) analyze → translate → bounded
 * review/revision rounds, streaming progress and structured results
 * through the workflow stream writer.
 */
export async function runTranslationWorkflow(
  options: TranslationRunOptions,
): Promise<void> {
  const {
    sourceText,
    targetLanguage,
    glossaryEntries,
    mode,
    modelId,
    writer,
    signal,
  } = options;
  const maxRounds = Math.min(
    Math.max(options.maxReviewRounds ?? MAX_REVIEW_ROUNDS, 0),
    MAX_REVIEW_ROUNDS,
  );

  const client = createAzureClient();
  const glossaryBlock = buildGlossaryBlock(glossaryEntries, sourceText);

  // Phase 1 — analysis (agentic only)
  let analysis: TranslationAnalysis | undefined;
  if (mode === 'agentic') {
    writer.activity('chat.activity.workflow.analyzingSource');
    analysis = await callStructured<TranslationAnalysis>({
      client,
      model: modelId,
      system: buildAnalysisSystemPrompt(),
      user: buildAnalysisUserPrompt(sourceText, targetLanguage),
      schemaName: 'translation_analysis',
      schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
    });
    writer.event({
      workflow: 'translation',
      type: 'analysis',
      data: analysis,
    });
  }

  // Phase 2 — translation, streamed as display text so the target pane
  // fills live.
  writer.activity('chat.activity.workflow.translating');
  let translation = await callStreamedText({
    client,
    model: modelId,
    system: buildTranslationSystemPrompt(
      glossaryBlock,
      analysis ? analysisToNotes(analysis) : undefined,
    ),
    user: buildTranslationUserPrompt(sourceText, targetLanguage),
    onDelta: (delta) => writer.text(delta),
    signal,
  });

  // Phase 3 — bounded review rounds (agentic only)
  let rounds = 0;
  if (mode === 'agentic') {
    const priorIssues: string[] = [];
    for (let round = 1; round <= maxRounds; round++) {
      if (signal?.aborted) return;
      writer.activity('chat.activity.workflow.reviewingTranslation', {
        round: String(round),
        total: String(maxRounds),
      });

      const review = await callStructured<ReviewResult>({
        client,
        model: modelId,
        system: buildReviewSystemPrompt(glossaryBlock),
        user: buildReviewUserPrompt(
          sourceText,
          translation,
          targetLanguage,
          priorIssues,
        ),
        schemaName: 'translation_review',
        schema: REVIEW_SCHEMA as unknown as Record<string, unknown>,
      });

      rounds = round;
      writer.event({
        workflow: 'translation',
        type: 'review_round',
        data: { round, verdict: review.verdict, issues: review.issues },
      });

      if (review.verdict === 'approve') break;

      priorIssues.push(
        ...review.issues.map((i) => `${i.excerpt}: ${i.problem}`),
      );
      if (review.revisedText && review.revisedText.trim()) {
        // Computed diff (not model self-report) — honest by construction.
        const changes = computeSegmentChanges(translation, review.revisedText);
        translation = review.revisedText;
        // Revisions replace the pane content — sent as an event, not
        // display text, so the client swaps rather than appends.
        writer.event({
          workflow: 'translation',
          type: 'revision',
          data: { round, text: translation, changes },
        });
      }
    }
  }

  writer.event({
    workflow: 'translation',
    type: 'complete',
    data: { finalText: translation, rounds },
  });
}

/* ------------------------------------------------------------------ */
/* Quality assessment (MQM-derived; post-hoc, single structured call)  */
/* ------------------------------------------------------------------ */

export interface TranslationAssessmentOptions {
  sourceText: string;
  translation: string;
  targetLanguage: string;
  /** Built-in ids and/or 'custom:<uuid>' ids, already validated. */
  criterionIds: string[];
  /** Rubrics for the custom ids in `criterionIds`. */
  customById: Map<string, { name: string; rubric: string }>;
  glossaryEntries: GlossaryEntry[];
  modelId?: string;
}

export interface TranslationAssessmentResult {
  criteria: TranslationCriterionRating[];
  overallSummary: string;
  edits: TranslationEdit[];
}

interface LlmAssessment {
  criteria: Array<{
    id: string;
    rating: number;
    summary: string;
  }>;
  edits: TranslationEdit[];
  overallSummary: string;
}

const MAX_ASSESSMENT_EDITS = 20;

/**
 * One strict structured call rating the translation on the requested
 * criteria and proposing granular edits. Light sanitation only — locating
 * `before` in the (possibly changed) working text is the client's job at
 * apply time.
 */
export async function runTranslationAssessment(
  options: TranslationAssessmentOptions,
): Promise<TranslationAssessmentResult> {
  // Built over the REQUESTED ids (not by filtering the built-in list), so
  // custom criteria reach the prompt instead of being silently dropped.
  const rubric = options.criterionIds
    .map((id) =>
      criterionRubricLine(id, builtinRubricLine(id), options.customById),
    )
    .filter((line): line is string => line !== null);
  const glossaryBlock = buildGlossaryBlock(
    options.glossaryEntries,
    options.sourceText,
  );

  const client = createAzureClient();
  const result = await callStructured<LlmAssessment>({
    client,
    model: options.modelId,
    system: buildAssessmentSystemPrompt(rubric, glossaryBlock),
    user: buildAssessmentUserPrompt(
      options.sourceText,
      options.translation,
      options.targetLanguage,
    ),
    schemaName: 'translation_assessment',
    schema: buildAssessmentSchema(options.criterionIds),
  });

  const requested = new Set(options.criterionIds);
  const criteria: TranslationCriterionRating[] = result.criteria
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
