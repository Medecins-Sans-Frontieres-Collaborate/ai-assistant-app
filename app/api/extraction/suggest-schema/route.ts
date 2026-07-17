import { NextRequest } from 'next/server';

import { ServiceContainer } from '@/lib/services/ServiceContainer';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  ALL_FIELD_TYPES,
  proposeFlatSchema,
} from '@/lib/utils/server/extraction/proposeFlatSchema';

import { auth } from '@/auth';
import { z } from 'zod';

/**
 * Schema suggestion endpoint for the recipe editor's "Suggest with AI"
 * button. Sends free-text instructions (and optionally a sample of
 * material) to the shared `proposeFlatSchema` util and returns a
 * `RecipeField[]`-shaped suggestion the client can offer to the user.
 *
 * Unlike auto-mode, the Settings suggest path allows every recipe field
 * type (including `list<text>` / `list<number>`) and does NOT require a
 * metric column — the user is authoring their own recipe and may need
 * an all-text shape.
 */

const RequestSchema = z.object({
  instructions: z
    .string()
    .min(1, 'instructions are required')
    .max(4000, 'instructions too long (max 4,000 chars)'),
  /** Up to ~2k chars of sample material; longer is truncated client-side. */
  sampleText: z.string().max(8000).optional(),
  /**
   * Existing fields the user has already authored, so suggestions extend
   * rather than replace. Optional.
   */
  existingFields: z
    .array(
      z.object({
        name: z.string().max(64),
        type: z.string().max(32),
        description: z.string().max(500).optional(),
        required: z.boolean().optional(),
      }),
    )
    .max(30)
    .optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await auth();
    if (!session) {
      return unauthorizedResponse('Authentication required');
    }

    const rawBody = await req.json().catch(() => null);
    const parsed = RequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      return badRequestResponse(
        firstError
          ? `${firstError.path.join('.')}: ${firstError.message}`
          : 'Invalid request body',
        'VALIDATION_FAILED',
      );
    }

    const { instructions, sampleText, existingFields } = parsed.data;

    const userPromptParts: string[] = [`Instructions:\n${instructions}`];
    if (existingFields && existingFields.length > 0) {
      userPromptParts.push(
        `Existing fields (extend, do not duplicate):\n${existingFields
          .map(
            (f) =>
              `  - ${f.name} (${f.type}${f.required === false ? ', optional' : ''})${
                f.description ? `: ${f.description}` : ''
              }`,
          )
          .join('\n')}`,
      );
    }
    if (sampleText && sampleText.trim()) {
      userPromptParts.push(`Sample material:\n${sampleText.slice(0, 4000)}`);
    }

    const openAIClient = ServiceContainer.getInstance().getOpenAIClient();

    const fields = await proposeFlatSchema(openAIClient, userPromptParts, {
      allowedTypes: ALL_FIELD_TYPES,
      requireMetric: false,
    });

    // Strip the synthetic `id` field — the client assigns its own ids when
    // converting these into RecipeField rows in the editor.
    const responseFields = fields.map(({ id: _id, ...rest }) => rest);

    return successResponse({ fields: responseFields });
  } catch (error) {
    return handleApiError(error, 'POST /api/extraction/suggest-schema');
  }
}
