import { NextRequest } from 'next/server';

import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import {
  ALT_TEXT_SCHEMA,
  RawAltTextResponse,
  buildAltTextSystemPrompt,
  normalizeAltText,
} from '@/lib/services/workflows/shared/drafter/altText';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveVisionWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import { FILE_SIZE_LIMITS } from '@/lib/utils/app/const';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { getBlobBase64String } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import { getSpecAdapter } from '@/lib/utils/shared/drafter/adapters';

import { auth } from '@/auth';

export const maxDuration = 120;

/** Internal image refs only, as the data workflow's photo route accepts. */
const IMAGE_REF_RE = /^\/api\/file\/([0-9a-f]{64}\.[a-zA-Z0-9]{1,4})$/;

interface AltTextRequest {
  specKind: string;
  imageRef: string;
  language?: string;
  modelId?: string;
  conversationId?: string;
}

/**
 * POST /api/workflows/drafter/alt-text: suggests alt text for one attached
 * image. The image is read from the caller's own file store by its internal
 * ref (the blob path is user-namespaced), never from a URL.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  let body: AltTextRequest;
  try {
    body = (await req.json()) as AltTextRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const adapter = getSpecAdapter(body.specKind);
  if (!adapter) return badRequestResponse('Unknown specKind');
  if (!(await isWorkflowEnabled(adapter.workflow))) {
    return workflowDisabledResponse(adapter.workflow);
  }

  const match =
    typeof body.imageRef === 'string' ? IMAGE_REF_RE.exec(body.imageRef) : null;
  if (!match)
    return badRequestResponse('imageRef must be an internal file ref');
  const language =
    typeof body.language === 'string' && body.language.trim()
      ? body.language.trim().slice(0, 60)
      : 'English';

  const { denied, usage } = await beginWorkflowRun(
    session,
    'drafter_alt_text',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const dataUrl = await getBlobBase64String(
      getUserIdFromSession(session),
      match[1],
      'images',
      session.user,
    );
    // Re-check size cheaply: base64 is ~4/3 of the byte size.
    if (dataUrl.length > FILE_SIZE_LIMITS.IMAGE_MAX_BYTES * 1.4) {
      return badRequestResponse('Image is too large', 'IMAGE_TOO_LARGE');
    }
    const raw = await callStructured<RawAltTextResponse>({
      client: createAzureClient(),
      model: resolveVisionWorkflowModelId(body.modelId),
      system: buildAltTextSystemPrompt(language),
      user: [
        { type: 'text', text: 'Write the alt text for this image.' },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
      schemaName: 'drafter_alt_text',
      schema: ALT_TEXT_SCHEMA,
      usage,
      usageLabel: 'alt-text',
    });
    return successResponse({ alt: normalizeAltText(raw), ...usage.fields() });
  } catch (error) {
    console.error(
      `[workflows/drafter/alt-text] Failed: ${sanitizeForLog(error)}`,
    );
    return handleApiError(error, 'Alt text could not be suggested');
  }
}
