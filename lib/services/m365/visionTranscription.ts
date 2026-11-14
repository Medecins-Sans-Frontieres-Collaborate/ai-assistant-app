/**
 * Image description and page OCR for M365 agent sources, as the `vision`
 * helper operation (lib/services/auxiliary/auxiliaryCompletion.ts).
 *
 * Images are user content, so they are read only by residency-verified
 * models in the processing region, and only by those whose metadata
 * declares vision support (`supportsVision` in config/models.json). There
 * is no hardcoded model: when the region's chain has no vision-capable
 * model, the call fails with VisionUnavailableError and the caller reports
 * it, instead of sending the image elsewhere.
 */
import type { Session } from 'next-auth';

import { auxiliaryFailure } from '@/lib/services/auxiliary/AuxiliaryModelExecutor';
import {
  type AuxiliaryCompletionService,
  getAuxiliaryCompletions,
} from '@/lib/services/auxiliary/auxiliaryCompletion';
import type { AuxiliaryRegion } from '@/lib/services/auxiliary/types';
import { recordTokenUsage } from '@/lib/services/observability/tokenUsageRecorder';

import type { AuxiliaryUsageSink } from '@/types/chat';

import type OpenAI from 'openai';

/** Describe an image so text search can find it. */
export const IMAGE_DESCRIPTION_PROMPT =
  'You are preparing an image so it can be found by text search. Write plain text, no markdown: ' +
  '(1) a factual description of what the image shows; (2) every piece of visible text transcribed ' +
  'verbatim, including numbers, dates, labels and captions; (3) if it is a chart, table or diagram, ' +
  'the data and relationships it conveys. Do not speculate about what is not visible.';

/** Transcribe one scanned page. */
export const PAGE_OCR_PROMPT =
  'This is one page of a scanned document. Transcribe ALL text on the page verbatim, preserving ' +
  'reading order, headings and paragraph breaks. Render tables as rows of cells separated by " | ". ' +
  'Briefly describe figures in square brackets. Output plain text only.';

/** Output room for a dense page transcription. */
export const VISION_MAX_OUTPUT_TOKENS = 4_096;
/** One image, across every chain attempt. Dense pages take a while. */
export const VISION_TIMEOUT_MS = 90_000;

/** Where an image may be read. */
export interface VisionRouting {
  /** Residency region (agent content: AGENT_CONTENT_REGION). */
  region: AuxiliaryRegion;
  /** Token-usage sink (the preparing admin). */
  onUsage?: AuxiliaryUsageSink;
  /** Cancels the call. */
  signal?: AbortSignal;
}

/**
 * Where M365 agent content is read. Agent sources are shared across the
 * organization and carry no per-user residency, so they are always
 * processed under the strictest residency: EU.
 */
export const AGENT_CONTENT_REGION: AuxiliaryRegion = 'EU';

/**
 * Vision routing for agent work an admin starts: always
 * AGENT_CONTENT_REGION, whatever the admin's own region, with usage
 * recorded against the admin.
 */
export function visionRoutingFor(session: Session): VisionRouting {
  return {
    region: AGENT_CONTENT_REGION,
    onUsage: (usage, model) =>
      recordTokenUsage(usage, model, session.user, false),
  };
}

/** The text a vision call produced and the model that read the image. */
export interface VisionTranscription {
  text: string;
  /** Model id that served the call (recorded with the derived text). */
  model: string;
}

/** No residency-eligible, vision-capable model could read the image. */
export class VisionUnavailableError extends Error {
  constructor(
    readonly region: AuxiliaryRegion,
    readonly reason: string,
  ) {
    super(
      `No vision-capable model is available for ${region} processing (${reason}). ` +
        'Assign one under Models in Admin.',
    );
    this.name = 'VisionUnavailableError';
  }
}

/**
 * The vision request for one image. Exported so the auxiliary readiness
 * probe (auxiliary/probes.ts) exercises exactly what runtime sends.
 *
 * @param image - Image bytes.
 * @param mimeType - The image MIME type (e.g. image/png).
 * @param prompt - IMAGE_DESCRIPTION_PROMPT, PAGE_OCR_PROMPT or a probe prompt.
 */
export function visionRequest(
  image: Buffer,
  mimeType: string,
  prompt: string,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  return {
    model: '',
    reasoning_effort: 'low',
    max_completion_tokens: VISION_MAX_OUTPUT_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${image.toString('base64')}`,
              detail: 'high',
            },
          },
        ],
      },
    ],
  };
}

/** Accepts any non-empty text; undefined rejects the reply. */
export function acceptVisionText(
  text: string | null | undefined,
): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Reads one image on a vision-capable model in the routing region.
 *
 * @param image - Image bytes.
 * @param mimeType - The image MIME type.
 * @param prompt - What to produce (IMAGE_DESCRIPTION_PROMPT or PAGE_OCR_PROMPT).
 * @param routing - Region, usage sink, cancellation.
 * @param completions - The helper-model service (defaults to the shared one).
 * @returns The text and the serving model.
 * @throws VisionUnavailableError when no eligible model produced text;
 *         cancellation rethrows as-is.
 */
export async function transcribeImage(
  image: Buffer,
  mimeType: string,
  prompt: string,
  routing: VisionRouting,
  completions?: AuxiliaryCompletionService,
): Promise<VisionTranscription> {
  const service = completions ?? (await getAuxiliaryCompletions());
  try {
    const answer = await service.completeJson({
      operation: 'vision',
      region: routing.region,
      params: visionRequest(image, mimeType, prompt),
      accept: (response) =>
        acceptVisionText(response.choices[0]?.message?.content),
      timeoutMs: VISION_TIMEOUT_MS,
      signal: routing.signal,
      onUsage: routing.onUsage,
    });
    return { text: answer.value, model: answer.model ?? 'vision' };
  } catch (error) {
    if (routing.signal?.aborted) throw error;
    throw new VisionUnavailableError(
      routing.region,
      auxiliaryFailure(error).reason,
    );
  }
}
