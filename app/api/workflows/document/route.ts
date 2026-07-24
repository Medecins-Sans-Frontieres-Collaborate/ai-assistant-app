import { NextRequest } from 'next/server';

import {
  DocumentReferenceInput,
  QualityGuidanceItem,
  ToneInput,
  buildGenerateSystemPrompt,
  buildGenerateUserPrompt,
  buildQualityGuidanceBlock,
  buildReviseUserPrompt,
  buildSelectionReviseUserPrompt,
  buildSpecBlock,
  buildToneBlock,
} from '@/lib/services/workflows/document/prompts';
import {
  structureGuideToSpec,
  toneGuideToToneInput,
} from '@/lib/services/workflows/shared/guidePrompts';
import { resolveSlotGuide } from '@/lib/services/workflows/shared/guideResolution';
import { truncateToTokenBudget } from '@/lib/services/workflows/shared/textBudget';
import {
  callStreamedText,
  createAzureClient,
  createWorkflowStream,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';

import {
  badRequestResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';

export const maxDuration = 300;

/** Per-reference token budget; keeps many references from crowding the prompt. */
const REFERENCE_TOKEN_BUDGET = 12_000;
const MAX_REFERENCES = 8;
const MAX_INSTRUCTION_CHARS = 8_000;
const MAX_DOC_CHARS = 400_000;

const MAX_SPEC_SECTIONS = 30;
const MAX_GUIDANCE_ITEMS = 12;
const MAX_RUBRIC_CHARS = 2_000;

interface DocumentWorkflowRequest {
  instruction: string;
  mode: 'generate' | 'revise';
  currentDocMarkdown?: string;
  /**
   * Selection scope for revise: the instruction applies only to this
   * excerpt (verbatim substring of currentDocMarkdown) and the stream
   * returns ONLY the revised excerpt.
   */
  selection?: string;
  references?: DocumentReferenceInput[];
  /** Attached document spec (inline; stateless server). */
  spec?: import('@/types/workflow').DocumentSpec;
  /** Attached voice/tone rules. */
  tone?: ToneInput;
  /** Admin structure guide filling the spec slot (exclusive with spec). */
  specGuideId?: string;
  /** Admin tone guide filling the tone slot (exclusive with tone). */
  toneGuideId?: string;
  /** Selected quality criteria rubrics upheld while writing. */
  qualityGuidance?: QualityGuidanceItem[];
  modelId?: string;
}

/**
 * POST /api/workflows/document — streams the complete (re)written document
 * as markdown display text, then a `doc_complete` WORKFLOW_EVENT. Wire
 * format matches the chat stream (text/plain + sentinel markers).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: DocumentWorkflowRequest;
  try {
    body = (await req.json()) as DocumentWorkflowRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  const instruction = body.instruction?.trim();
  if (!instruction) return badRequestResponse('Instruction is required');
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    return badRequestResponse('Instruction is too long');
  }
  if (body.mode !== 'generate' && body.mode !== 'revise') {
    return badRequestResponse('mode must be "generate" or "revise"');
  }
  if (body.mode === 'revise' && !body.currentDocMarkdown) {
    return badRequestResponse('currentDocMarkdown is required for revise');
  }
  if ((body.currentDocMarkdown?.length ?? 0) > MAX_DOC_CHARS) {
    return badRequestResponse('Document is too large');
  }
  // Plain-text rendering of the selected region (advisory context; the
  // client replaces the range by editor positions, not string matching).
  const selection =
    typeof body.selection === 'string' && body.selection.trim()
      ? body.selection.slice(0, MAX_DOC_CHARS)
      : undefined;
  if (selection && body.mode !== 'revise') {
    return badRequestResponse('selection is only valid for revise');
  }
  const rawReferences = Array.isArray(body.references)
    ? body.references.slice(0, MAX_REFERENCES)
    : [];

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
  // Slot guides resolve server-side (fail-closed, access re-checked) BEFORE
  // the stream opens so a stale/revoked reference is a clean 400, not a
  // mid-stream failure.
  const userMail = session.user?.mail ?? undefined;
  // Slot guides convert to the REAL DocumentSpec/ToneInput shapes and flow
  // through the same buildSpecBlock/buildToneBlock as local attachments.
  let guideSpec: import('@/types/workflow').DocumentSpec | undefined;
  if (typeof body.specGuideId === 'string' && body.specGuideId) {
    const resolved = await resolveSlotGuide({
      userMail,
      guideId: body.specGuideId,
      expectedKind: 'structure',
      workflow: 'document',
    });
    if ('error' in resolved) return badRequestResponse(resolved.error);
    guideSpec = structureGuideToSpec(resolved.guide) ?? undefined;
  }
  let guideTone: ToneInput | undefined;
  if (typeof body.toneGuideId === 'string' && body.toneGuideId) {
    const resolved = await resolveSlotGuide({
      userMail,
      guideId: body.toneGuideId,
      expectedKind: 'tone',
      workflow: 'document',
    });
    if ('error' in resolved) return badRequestResponse(resolved.error);
    guideTone = toneGuideToToneInput(resolved.guide) ?? undefined;
  }

  const { stream, writer } = createWorkflowStream();

  // Run the LLM work after returning the stream so the client sees
  // progress markers immediately.
  void (async () => {
    try {
      writer.activity('chat.activity.workflow.preparingDocument');

      const references: DocumentReferenceInput[] = [];
      for (const ref of rawReferences) {
        if (!ref?.name || typeof ref.text !== 'string') continue;
        const budgeted = await truncateToTokenBudget(
          ref.text,
          REFERENCE_TOKEN_BUDGET,
        );
        references.push({ name: String(ref.name), text: budgeted.text });
      }

      writer.activity('chat.activity.workflow.writingDocument');

      // Optional writing constraints: spec, tone, and quality guidance
      // travel inline (stateless server) and become system-prompt blocks.
      let extraBlocks = '';
      if (
        body.spec &&
        Array.isArray(body.spec.sections) &&
        body.spec.sections.length <= MAX_SPEC_SECTIONS
      ) {
        extraBlocks += buildSpecBlock(body.spec);
      } else if (guideSpec) {
        // Guide-derived specs are capped at write time (≤ MAX_GUIDE_SECTIONS
        // = MAX_SPEC_SECTIONS), so no re-check here.
        extraBlocks += buildSpecBlock(guideSpec);
      }
      if (body.tone?.voiceRules) {
        extraBlocks += buildToneBlock(body.tone);
      } else if (guideTone) {
        extraBlocks += buildToneBlock(guideTone);
      }
      const guidance = Array.isArray(body.qualityGuidance)
        ? body.qualityGuidance
            .filter(
              (g) =>
                g &&
                typeof g.name === 'string' &&
                typeof g.rubric === 'string' &&
                g.rubric.length <= MAX_RUBRIC_CHARS,
            )
            .slice(0, MAX_GUIDANCE_ITEMS)
        : [];
      extraBlocks += buildQualityGuidanceBlock(guidance);

      const client = createAzureClient();
      const system = buildGenerateSystemPrompt(
        references.length > 0,
        extraBlocks,
      );
      const user =
        body.mode === 'generate'
          ? buildGenerateUserPrompt(instruction, references)
          : selection
            ? buildSelectionReviseUserPrompt(
                instruction,
                body.currentDocMarkdown as string,
                selection,
                references,
              )
            : buildReviseUserPrompt(
                instruction,
                body.currentDocMarkdown as string,
                references,
              );

      const markdown = await callStreamedText({
        client,
        model: resolveWorkflowModelId(body.modelId),
        system,
        user,
        onDelta: (delta) => writer.text(delta),
        signal: req.signal,
      });

      writer.event({
        workflow: 'document',
        type: 'doc_complete',
        data: { chars: markdown.length, mode: body.mode, scoped: !!selection },
      });
      writer.close();
    } catch (error) {
      console.error('[workflows/document] Failed:', error);
      writer.fail(
        'document',
        error instanceof Error ? error.message : 'Document generation failed',
      );
    }
  })();

  return new Response(stream, { headers: STREAMING_RESPONSE_HEADERS });
}
