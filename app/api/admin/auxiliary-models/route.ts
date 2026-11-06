/** Global-admin-only environment-local policy, inventory refresh, and fixed compatibility probes. */
import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { STRONG_ETAG_REGEX } from '@/lib/services/agentAccess/adminRouteHelpers';
import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import { AuxiliaryModelService } from '@/lib/services/auxiliary/AuxiliaryModelService';
import { readAuxiliaryAdminBody } from '@/lib/services/auxiliary/adminBody';
import { auxiliaryEnvironment } from '@/lib/services/auxiliary/bindings';
import { resolveAuxiliaryCandidate } from '@/lib/services/auxiliary/resolution';
import {
  recordAuxiliaryHistory,
  writeAuxiliaryPolicy,
} from '@/lib/services/auxiliary/store';
import {
  AUXILIARY_LIMITS,
  AUXILIARY_PURPOSES,
  AUXILIARY_REGIONS,
  AuxiliaryAssignmentsSchema,
  AuxiliaryReferenceSchema,
  PURPOSE_OPERATIONS,
  referenceKey,
} from '@/lib/services/auxiliary/types';
import { AUXILIARY_OPERATION_REVISION } from '@/lib/services/auxiliary/types';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { z } from 'zod';

/** Return environment-local policy/readiness. Optional refresh performs inventory reads, never inference. */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();
  try {
    return successResponse(
      await AuxiliaryModelService.getInstance().report(
        request.nextUrl.searchParams.get('refresh') === '1',
      ),
    );
  } catch (error) {
    return handleApiError(error, 'Unable to read auxiliary model readiness');
  }
}

/** Validate exact account/deployment references and CAS-save this environment's approved chains. */
export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user) || !session.user.mail)
    return forbiddenResponse();
  let body: unknown;
  try {
    body = await readAuxiliaryAdminBody(request);
  } catch {
    return badRequestResponse('Invalid or oversized JSON body');
  }
  const parsed = z
    .object({ assignments: AuxiliaryAssignmentsSchema })
    .strict()
    .safeParse(body);
  if (!parsed.success)
    return badRequestResponse(
      'Invalid model assignments',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  const etag = request.headers.get('if-match');
  if (etag !== null && !STRONG_ETAG_REGEX.test(etag))
    return badRequestResponse('If-Match must be a quoted strong ETag');
  try {
    const service = AuxiliaryModelService.getInstance();
    const report = await service.report(true);
    if (
      report.configUnavailable ||
      report.inventory.some(
        (entry) => entry.account.configured && entry.status !== 'current',
      )
    )
      return errorResponse(
        'Configuration or inventory checks unavailable; refresh before saving',
        503,
      );
    for (const purpose of AUXILIARY_PURPOSES)
      for (const region of AUXILIARY_REGIONS) {
        const entries = parsed.data.assignments[purpose][region];
        let eligible = 0;
        for (const reference of entries) {
          const existing = report.effective[purpose][region].some(
            (old) => referenceKey(old) === referenceKey(reference),
          );
          const resolved = resolveAuxiliaryCandidate(
            reference,
            report.inventory.find(
              (entry) => entry.account.binding === reference.accountBinding,
            ),
            region,
            report.observations,
          );
          if (!resolved.status.eligible) {
            if (existing) continue;
            return badRequestResponse(
              `${purpose}.${region}: ${referenceKey(reference)} is ineligible (${resolved.status.reason})`,
            );
          }
          eligible++;
          if (
            !existing &&
            !PURPOSE_OPERATIONS[purpose].every((operation) => {
              const latest = resolved.status.observations
                .filter((entry) => entry.operation === operation)
                .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
              return (
                latest?.success &&
                latest.operationRevision === AUXILIARY_OPERATION_REVISION &&
                Date.now() - Date.parse(latest.checkedAt) <
                  AUXILIARY_LIMITS.probeFreshMs
              );
            })
          )
            return badRequestResponse(
              `${purpose}.${region}: run compatibility checks before adding ${referenceKey(reference)}`,
            );
        }
        if (!eligible)
          return badRequestResponse(
            `${purpose}.${region}: at least one eligible deployment is required`,
          );
      }
    const policy = {
      version: 1 as const,
      environment: auxiliaryEnvironment(),
      assignments: parsed.data.assignments,
      updatedAt: new Date().toISOString(),
      updatedBy: session.user.mail.trim().toLowerCase(),
    };
    const revision = await writeAuxiliaryPolicy(policy, etag);
    await recordAuxiliaryHistory(policy, revision);
    service.invalidate();
    return successResponse(await service.report());
  } catch (error) {
    if (error instanceof AgentAccessConflictError)
      return errorResponse(
        'Model assignments changed; reload before saving',
        409,
        undefined,
        'AUXILIARY_POLICY_CONFLICT',
      );
    return handleApiError(error, 'Unable to save model assignments');
  }
}

/** Run server-owned, rate-limited app-credential probes on one validated deployment. */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();
  let body: unknown;
  try {
    body = await readAuxiliaryAdminBody(request);
  } catch {
    return badRequestResponse('Invalid or oversized JSON body');
  }
  const parsed = z
    .object({
      reference: AuxiliaryReferenceSchema,
      purpose: z.enum(AUXILIARY_PURPOSES),
      region: z.enum(AUXILIARY_REGIONS),
    })
    .strict()
    .safeParse(body);
  if (!parsed.success) return badRequestResponse('Invalid compatibility check');
  try {
    return successResponse(
      await AuxiliaryModelService.getInstance().probe(
        parsed.data.reference,
        parsed.data.purpose,
        parsed.data.region,
      ),
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'PROBE_RATE_LIMIT')
      return errorResponse(
        'Wait before repeating this deployment compatibility check',
        429,
      );
    if (
      error instanceof Error &&
      error.message.startsWith('Probe target ineligible:')
    )
      return badRequestResponse(error.message);
    return handleApiError(error, 'Compatibility check unavailable');
  }
}
