import { NextRequest } from 'next/server';

import { ServiceContainer } from '@/lib/services/ServiceContainer';
import {
  isAnnouncementsAdmin,
  resolveAnnouncementsAdmin,
} from '@/lib/services/announcements/adminAccess';
import { translateAnnouncement } from '@/lib/services/announcements/translate';
import {
  SOURCE_ACTION_LABEL_CHARS,
  SOURCE_BODY_CHARS,
  SOURCE_TITLE_CHARS,
  VARIABLE_NAME_RE,
  validateLocalizedText,
} from '@/lib/services/announcements/types';

import { getSupportedLocales } from '@/lib/utils/app/locales';
import {
  badRequestResponse,
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { z } from 'zod';

/**
 * POST /api/admin/announcements/translate — AI localization of a draft into
 * the supported languages. STATELESS: nothing is stored. The editor receives
 * the translations for review, and the normal save path validates them again.
 */

export const maxDuration = 120;

const bodySchema = z
  .object({
    sourceLocale: z.string().max(10),
    title: z.string().min(1).max(SOURCE_TITLE_CHARS),
    body: z.string().max(SOURCE_BODY_CHARS),
    actionLabel: z.string().max(SOURCE_ACTION_LABEL_CHARS).optional(),
    variableNames: z.array(z.string().regex(VARIABLE_NAME_RE)).max(6),
    /** Omitted → every supported language except the source. */
    targetLocales: z.array(z.string().max(10)).max(100).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { status } = await resolveAnnouncementsAdmin(session.user);
  if (!isAnnouncementsAdmin(status)) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid translation request',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }

  const supported = getSupportedLocales();
  if (!supported.includes(parsed.data.sourceLocale)) {
    return badRequestResponse('Unsupported source language');
  }
  const targetLocales = (parsed.data.targetLocales ?? supported).filter(
    (locale) => supported.includes(locale),
  );
  for (const text of [
    parsed.data.title,
    parsed.data.body,
    parsed.data.actionLabel ?? '',
  ]) {
    const complaint = validateLocalizedText(text, parsed.data.variableNames);
    if (complaint) return badRequestResponse('Invalid source text', complaint);
  }

  try {
    const outcome = await translateAnnouncement(
      ServiceContainer.getInstance().getOpenAIClient(),
      {
        source: {
          title: parsed.data.title,
          body: parsed.data.body,
          ...(parsed.data.actionLabel
            ? { actionLabel: parsed.data.actionLabel }
            : {}),
        },
        sourceLocale: parsed.data.sourceLocale,
        targetLocales,
        variableNames: parsed.data.variableNames,
      },
    );
    return successResponse(outcome);
  } catch (error) {
    return handleApiError(error, 'Failed to translate announcement');
  }
}
