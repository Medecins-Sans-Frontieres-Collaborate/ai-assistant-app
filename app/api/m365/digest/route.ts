/**
 * Daily digest jobs (docs/M365_DAILY_DIGEST.md).
 *
 * POST /api/m365/digest  { window, sources, channels } → the pending job.
 * Poll GET /api/m365/digest/{jobId} for progress and the result.
 *
 * The window arrives already resolved by the client (local-time presets
 * such as "since the last workday" only make sense there); the server
 * validates its shape and span. Runs are a per-day budget
 * (`feature.m365.digestRunsPerDay`): one digest is dozens of Graph reads
 * and two utility-model calls.
 */
import { NextRequest } from 'next/server';

import { guardLimit } from '@/lib/services/limits/routeGuard';
import { DigestBusyError } from '@/lib/services/m365/digest/digestJobStore';
import { startDigestJob } from '@/lib/services/m365/digest/digestService';
import { validateDigestWindow } from '@/lib/services/m365/digest/digestWindow';
import {
  isValidGraphId,
  m365ErrorResponse,
  mintGraphToken,
} from '@/lib/services/m365/graphApi';
import { isValidChannelId } from '@/lib/services/m365/tools/shared';

import {
  badRequestResponse,
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import {
  DIGEST_SOURCE_KINDS,
  type DigestChannelRef,
  type DigestRequest,
  type DigestSourceKind,
} from '@/types/m365Digest';

import { auth } from '@/auth';

const DIGEST_MAX_CHANNELS = 10;
const DIGEST_RUNS_LIMIT_KEY = 'feature.m365.digestRunsPerDay';

function parseChannels(raw: unknown): DigestChannelRef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new RangeError('channels must be an array');
  if (raw.length > DIGEST_MAX_CHANNELS) {
    throw new RangeError(`At most ${DIGEST_MAX_CHANNELS} channels per digest`);
  }
  const seen = new Set<string>();
  const channels: DigestChannelRef[] = [];
  for (const entry of raw) {
    const channel = entry as Partial<DigestChannelRef> | null;
    if (
      !channel ||
      !isValidGraphId(channel.teamId) ||
      typeof channel.channelId !== 'string' ||
      !isValidChannelId(channel.channelId) ||
      typeof channel.name !== 'string'
    ) {
      throw new RangeError('channels entries need teamId, channelId and name');
    }
    const key = `${channel.teamId}/${channel.channelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    channels.push({
      teamId: channel.teamId,
      channelId: channel.channelId,
      name: channel.name.trim().slice(0, 120) || 'Channel',
    });
  }
  return channels;
}

function parseSources(raw: unknown): DigestSourceKind[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RangeError('sources must list at least one source');
  }
  const sources = [...new Set(raw)].filter((kind): kind is DigestSourceKind =>
    DIGEST_SOURCE_KINDS.includes(kind as DigestSourceKind),
  );
  if (sources.length === 0) throw new RangeError('no known sources requested');
  return sources;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return unauthorizedResponse();

  let body: { window?: unknown; sources?: unknown; channels?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequestResponse('Expected a JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return badRequestResponse('Expected a JSON object body');
  }
  let request: DigestRequest;
  try {
    const window = validateDigestWindow(
      (body.window ?? {}) as Record<string, unknown>,
    );
    request = {
      window,
      sources: parseSources(body.sources),
      channels: parseChannels(body.channels),
    };
  } catch (error) {
    return badRequestResponse(
      error instanceof Error ? error.message : 'Invalid digest request',
    );
  }
  if (!request.sources.includes('channel')) request.channels = [];

  // A disconnected or unconsented account fails here, before a run is
  // charged, instead of producing an empty "succeeded" digest.
  try {
    await mintGraphToken(req, ['User.Read']);
  } catch (error) {
    return m365ErrorResponse(error);
  }

  const guard = await guardLimit(session, DIGEST_RUNS_LIMIT_KEY, { req });
  if (!guard.allowed) return guard.response!;

  try {
    const job = await startDigestJob(req, session, request);
    return successResponse({ jobId: job.jobId, status: job.status });
  } catch (error) {
    await guard.rollback?.();
    if (error instanceof DigestBusyError) {
      return errorResponse(error.message, 409, undefined, 'M365_DIGEST_BUSY');
    }
    return m365ErrorResponse(error);
  }
}
