import { NextRequest } from 'next/server';

import {
  runDocumentAssessment,
  runDocumentProfile,
} from '@/lib/services/workflows/document/documentOrchestrator';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  isCustomCriterionId,
  isDocumentBuiltinCriterionId,
} from '@/lib/utils/shared/document/qualityCriteria';

import { DocumentProfile, DocumentSpec } from '@/types/workflow';

import { auth } from '@/auth';

export const maxDuration = 300;

const MAX_DOC_CHARS = 60_000;
const MAX_CRITERIA = 12;
const MAX_SPEC_SECTIONS = 30;
const MAX_RUBRIC_CHARS = 2_000;
const MAX_NAME_CHARS = 100;

interface DocumentAssessRequest {
  /** htmlToMarkdown(docHtml) — always the FULL document. */
  docMarkdown: string;
  /** Scope the assessment to this excerpt (substring of docMarkdown). */
  selection?: string;
  /** Empty array = profile-only run. */
  criteria: string[];
  /** Definitions for any requested 'custom:' ids (stateless server). */
  customCriteria?: Array<{ id: string; name: string; rubric: string }>;
  spec?: DocumentSpec;
  tone?: { name: string; voiceRules: string; examples?: string };
  /** Fresh client-side profile; server re-profiles when absent. */
  profile?: DocumentProfile;
  modelId?: string;
}

/**
 * POST /api/workflows/document/assess — agentic pre-assessment (profile)
 * and criterion-based quality assessment producing granular edits. One
 * route: `criteria: []` runs the profile only; otherwise the server
 * profiles first when no fresh profile is supplied (the detected
 * spelling variety feeds the grammar rubric).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: DocumentAssessRequest;
  try {
    body = (await req.json()) as DocumentAssessRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  const docMarkdown = body.docMarkdown;
  if (!docMarkdown?.trim()) {
    return badRequestResponse('Document text is required');
  }
  if (docMarkdown.length > MAX_DOC_CHARS) {
    return badRequestResponse('Document is too long to assess');
  }
  if (!Array.isArray(body.criteria)) {
    return badRequestResponse('criteria must be an array');
  }
  const criterionIds = [...new Set(body.criteria)];
  if (criterionIds.length > MAX_CRITERIA) {
    return badRequestResponse('Too many criteria');
  }

  // Validate custom criterion definitions for every requested custom id.
  const customById = new Map<string, { name: string; rubric: string }>();
  for (const def of body.customCriteria ?? []) {
    if (
      def &&
      typeof def.id === 'string' &&
      isCustomCriterionId(def.id) &&
      typeof def.name === 'string' &&
      def.name.trim() !== '' &&
      def.name.length <= MAX_NAME_CHARS &&
      typeof def.rubric === 'string' &&
      def.rubric.trim() !== '' &&
      def.rubric.length <= MAX_RUBRIC_CHARS
    ) {
      customById.set(def.id, { name: def.name, rubric: def.rubric });
    }
  }
  for (const id of criterionIds) {
    if (isDocumentBuiltinCriterionId(id)) continue;
    if (isCustomCriterionId(id) && customById.has(id)) continue;
    return badRequestResponse('Unknown criterion');
  }
  if (criterionIds.includes('specAdherence') && !body.spec) {
    return badRequestResponse('specAdherence requires an attached spec');
  }
  if (criterionIds.includes('toneAdherence') && !body.tone) {
    return badRequestResponse('toneAdherence requires an attached tone');
  }
  if (body.spec && (body.spec.sections?.length ?? 0) > MAX_SPEC_SECTIONS) {
    return badRequestResponse('Spec has too many sections');
  }
  // The selection is the editor's plain-text rendering of the region, so
  // it is NOT required to be a byte-exact substring of the markdown —
  // it's advisory context; edits stay anchored to the document markdown.
  const selection =
    typeof body.selection === 'string' && body.selection.trim()
      ? body.selection.slice(0, MAX_DOC_CHARS)
      : undefined;

  const modelId = resolveWorkflowModelId(body.modelId);

  try {
    // Profile: reuse a fresh client-supplied one, else compute.
    let profile = body.profile;
    if (!profile) {
      const result = await runDocumentProfile({ docMarkdown, modelId });
      profile = {
        ...result,
        contentHash: 0, // client stamps the hash of its own markdown
        createdAt: new Date().toISOString(),
      };
    }

    if (criterionIds.length === 0) {
      return successResponse({
        profile,
        criteria: [],
        overallSummary: '',
        edits: [],
      });
    }

    const assessment = await runDocumentAssessment({
      docMarkdown,
      selection,
      criterionIds,
      customById,
      spec: body.spec,
      tone: body.tone,
      language: profile.language,
      conventionNotes: profile.conventionNotes,
      modelId,
    });

    return successResponse({ profile, ...assessment });
  } catch (error) {
    console.error('[workflows/document/assess] Failed:', error);
    return handleApiError(error, 'Assessment failed');
  }
}
