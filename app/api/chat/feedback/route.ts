/**
 * POST /api/chat/feedback — records a good/bad rating on an assistant message
 * as a `MessageFeedback` custom metric (MetricValue 1 = good, -1 = bad).
 *
 * Only ids and the model/agent are logged, never message content.
 */
import { NextRequest } from 'next/server';

import { getAzureMonitorLogger } from '@/lib/services/observability/AzureMonitorLoggingService';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { z } from 'zod';

const feedbackSchema = z.object({
  rating: z.enum(['good', 'bad']),
  messageId: z.string().max(128).optional(),
  conversationId: z.string().max(128).optional(),
  model: z.string().max(128).optional(),
  botId: z.string().max(128).optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const parsed = feedbackSchema.safeParse(
    await req.json().catch(() => undefined),
  );
  if (!parsed.success) return badRequestResponse('Invalid feedback');

  const { rating, ...ids } = parsed.data;
  const tags = Object.fromEntries(
    Object.entries(ids).filter(([, value]) => value),
  ) as Record<string, string>;

  void getAzureMonitorLogger().logCustomMetric({
    user: session.user,
    metricName: 'MessageFeedback',
    metricValue: rating === 'good' ? 1 : -1,
    tags,
  });

  return successResponse();
}
