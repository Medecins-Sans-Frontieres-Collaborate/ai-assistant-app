/**
 * §4 tier 2: import a Teams meeting recording (MP4) into upload storage so
 * the standard transcription pipeline (§3) takes over — size routing,
 * minute budgets, chunked polling all unchanged. Bytes go Graph → blob
 * server-side; the browser only ever sees the upload reference.
 *
 * POST /api/m365/meetings/recording  { meetingId, recordingId, fileName? }
 */
import { NextRequest } from 'next/server';

import { guardLimit } from '@/lib/services/limits/routeGuard';
import {
  M365Error,
  graphFetch,
  isValidGraphId,
} from '@/lib/services/m365/graphApi';
import {
  m365ImportErrorResponse,
  storeContentToUploads,
} from '@/lib/services/m365/m365ImportService';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

export const maxDuration = 300;

const SCOPES = ['OnlineMeetings.Read', 'OnlineMeetingRecording.Read.All'];

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#%]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || 'meeting-recording';
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  let body: { meetingId?: unknown; recordingId?: unknown; fileName?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequestResponse('Expected a JSON body');
  }
  const meetingId = typeof body.meetingId === 'string' ? body.meetingId : null;
  const recordingId =
    typeof body.recordingId === 'string' ? body.recordingId : null;
  if (!isValidGraphId(meetingId) || !isValidGraphId(recordingId)) {
    return badRequestResponse('Invalid meetingId or recordingId');
  }
  const rawName =
    typeof body.fileName === 'string' && body.fileName.trim()
      ? body.fileName
      : 'meeting-recording';
  const fileName = `${sanitizeFileName(rawName).replace(/\.mp4$/i, '')}.mp4`;

  const uploadGuard = await guardLimit(session, 'feature.upload.filesPerDay', {
    req,
  });
  if (!uploadGuard.allowed && uploadGuard.response) {
    return uploadGuard.response;
  }

  try {
    const content = await graphFetch(
      req,
      SCOPES,
      `/me/onlineMeetings/${encodeURIComponent(meetingId)}/recordings/${encodeURIComponent(recordingId)}/content`,
    );
    const contentLength = Number(content.headers.get('content-length') ?? 0);
    if (!content.body) {
      throw new M365Error(
        'Failed to download the recording',
        'graph_error',
        502,
      );
    }
    const imported = await storeContentToUploads(session, content, {
      name: fileName,
      size: Number.isFinite(contentLength) ? contentLength : 0,
      mimeType: 'video/mp4',
    });
    return successResponse(imported);
  } catch (error) {
    // Nothing was stored — hand the reserved daily-upload unit back.
    await uploadGuard.rollback?.();
    return m365ImportErrorResponse(error);
  }
}
