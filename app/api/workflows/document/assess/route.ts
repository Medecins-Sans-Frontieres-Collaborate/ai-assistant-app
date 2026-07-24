import { NextRequest } from 'next/server';

import {
  runDocumentAssessment,
  runDocumentProfile,
} from '@/lib/services/workflows/document/documentOrchestrator';
import {
  resolveGuideCriteria,
  resolveSlotGuide,
} from '@/lib/services/workflows/shared/guideResolution';
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
import {
  MAX_CRITERION_NAME_CHARS,
  MAX_CRITERION_RUBRIC_CHARS,
} from '@/lib/utils/shared/review/customCriteria';
import {
  MAX_GUIDES_PER_ASSESSMENT,
  isGuideCriterionId,
} from '@/lib/utils/shared/review/guideCriteria';

import { DocumentProfile, DocumentSpec } from '@/types/workflow';

import { auth } from '@/auth';

export const maxDuration = 300;

const MAX_DOC_CHARS = 60_000;
const MAX_CRITERIA = 12;
const MAX_SPEC_SECTIONS = 30;
// Re-exported from the shared module rather than redeclared: the editor that
// creates these criteria enforces the same numbers, and a local copy silently
// drifting is how an over-long rubric became "Unknown criterion".
const MAX_RUBRIC_CHARS = MAX_CRITERION_RUBRIC_CHARS;
const MAX_NAME_CHARS = MAX_CRITERION_NAME_CHARS;

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
  /** Admin structure guide filling the spec slot (mutually exclusive with spec). */
  specGuideId?: string;
  /** Admin tone guide filling the tone slot (mutually exclusive with tone). */
  toneGuideId?: string;
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
  //
  // Rejections are recorded with a reason rather than just dropped. A
  // definition that fails here still has a perfectly real id, so reporting
  // "Unknown criterion" sends the user hunting for a criterion that plainly
  // exists in their list — when the actual problem is that its rubric is too
  // long for the prompt budget.
  const customById = new Map<string, { name: string; rubric: string }>();
  const rejected = new Map<string, string>();
  for (const def of body.customCriteria ?? []) {
    if (!def || typeof def.id !== 'string' || !isCustomCriterionId(def.id)) {
      continue;
    }
    const name = typeof def.name === 'string' ? def.name : '';
    const rubric = typeof def.rubric === 'string' ? def.rubric : '';
    if (name.trim() === '') {
      rejected.set(def.id, 'needs a name');
    } else if (name.length > MAX_NAME_CHARS) {
      rejected.set(
        def.id,
        `name is ${name.length} characters; the limit is ${MAX_NAME_CHARS}`,
      );
    } else if (rubric.trim() === '') {
      rejected.set(def.id, 'needs a rubric');
    } else if (rubric.length > MAX_RUBRIC_CHARS) {
      rejected.set(
        def.id,
        `rubric is ${rubric.length} characters; the limit is ${MAX_RUBRIC_CHARS}`,
      );
    } else {
      customById.set(def.id, { name, rubric });
    }
  }
  for (const id of criterionIds) {
    if (isDocumentBuiltinCriterionId(id)) continue;
    if (isCustomCriterionId(id) && customById.has(id)) continue;
    // Guide ids are resolved (and access-checked) server-side below.
    if (isGuideCriterionId(id)) continue;
    const reason = rejected.get(id);
    if (reason) {
      const label = body.customCriteria?.find((d) => d?.id === id)?.name;
      return badRequestResponse(
        `Criterion ${label ? `"${label}"` : id} ${reason}`,
      );
    }
    return badRequestResponse('Unknown criterion');
  }
  const guideCriterionIds = criterionIds.filter(isGuideCriterionId);
  if (guideCriterionIds.length > MAX_GUIDES_PER_ASSESSMENT) {
    return badRequestResponse('Too many guides selected');
  }
  // Exactly one occupant per slot: a local spec and an admin structure guide
  // are competing prescriptions the model cannot follow simultaneously.
  if (body.spec && body.specGuideId) {
    return badRequestResponse(
      'Attach either a spec or a structure guide, not both',
    );
  }
  if (body.tone && body.toneGuideId) {
    return badRequestResponse('Attach either a tone or a tone guide, not both');
  }
  if (
    criterionIds.includes('specAdherence') &&
    !body.spec &&
    !body.specGuideId
  ) {
    return badRequestResponse('specAdherence requires an attached spec');
  }
  if (
    criterionIds.includes('toneAdherence') &&
    !body.tone &&
    !body.toneGuideId
  ) {
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

  // Guides resolve server-side (fail-closed): the client only ever sends ids,
  // so guide bodies bypass the custom-rubric cap without ever being
  // client-supplied. All failure modes share one generic message — denied
  // must stay indistinguishable from missing.
  const userMail = session.user?.mail ?? undefined;
  const guideResolution = await resolveGuideCriteria({
    userMail,
    workflow: 'document',
    criterionIds: guideCriterionIds,
  });
  if ('error' in guideResolution) {
    return badRequestResponse(guideResolution.error);
  }
  let structureGuide;
  if (typeof body.specGuideId === 'string' && body.specGuideId) {
    const resolved = await resolveSlotGuide({
      userMail,
      guideId: body.specGuideId,
      expectedKind: 'structure',
    });
    if ('error' in resolved) return badRequestResponse(resolved.error);
    structureGuide = resolved.guide;
  }
  let toneGuide;
  if (typeof body.toneGuideId === 'string' && body.toneGuideId) {
    const resolved = await resolveSlotGuide({
      userMail,
      guideId: body.toneGuideId,
      expectedKind: 'tone',
    });
    if ('error' in resolved) return badRequestResponse(resolved.error);
    toneGuide = resolved.guide;
  }

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
      guides: guideResolution.guides,
      spec: body.spec,
      tone: body.tone,
      structureGuide,
      toneGuide,
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
