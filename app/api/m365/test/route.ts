/**
 * M365 Scope Diagnostic Endpoint
 *
 * Reports, for each delegated Graph scope in the M365 integration catalog,
 * whether the tenant grant actually works for the signed-in user:
 *
 * 1. Mints a Graph token for that single scope from the user's refresh token
 *    (a missing admin consent surfaces as AADSTS65001 — reported as
 *    `consent_missing`, not an error).
 * 2. Where the catalog defines a read-only probe, calls it with the minted
 *    token to prove the scope works end-to-end.
 *
 * Every call is on the signed-in user's own token against their own content;
 * nothing is written or persisted.
 *
 * GET /api/m365/test
 */
import { NextRequest } from 'next/server';

import { M365ScopeDef, M365_SCOPES } from '@/lib/services/auth/m365GraphScopes';

import {
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth, getGraphAccessToken } from '@/auth';

const GRAPH_V1 = 'https://graph.microsoft.com/v1.0';
const CONSENT_ERROR_CODE = 'AADSTS65001';
const TOKEN_MINT_CONCURRENCY = 4;

interface ScopeTestResult {
  scope: string;
  phase: 1 | 2 | 3;
  feature: string;
  status: 'granted' | 'consent_missing' | 'error';
  /** Present when the catalog defines a probe and a token was minted. */
  probe?: {
    path: string;
    ok: boolean;
    httpStatus: number;
    detail?: string;
  };
  error?: string;
}

async function testScope(
  req: NextRequest,
  def: M365ScopeDef,
): Promise<ScopeTestResult> {
  const base: Pick<ScopeTestResult, 'scope' | 'phase' | 'feature'> = {
    scope: def.scope,
    phase: def.phase,
    feature: def.feature,
  };

  const token = await getGraphAccessToken(req, [def.scope]);

  if (!token.accessToken) {
    const consentMissing = token.error?.includes(CONSENT_ERROR_CODE) ?? false;
    return {
      ...base,
      status: consentMissing ? 'consent_missing' : 'error',
      error: token.error,
    };
  }

  if (!def.probe) {
    return { ...base, status: 'granted' };
  }

  try {
    const response = await fetch(`${GRAPH_V1}${def.probe}`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    let detail: string | undefined;
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      detail = body?.error?.message;
    }
    return {
      ...base,
      status: 'granted',
      probe: {
        path: def.probe,
        ok: response.ok,
        httpStatus: response.status,
        ...(detail && { detail }),
      },
    };
  } catch (error) {
    return {
      ...base,
      status: 'granted',
      probe: {
        path: def.probe,
        ok: false,
        httpStatus: 0,
        detail: error instanceof Error ? error.message : 'Request failed',
      },
    };
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  // Each scope is minted individually so a partial admin grant reports
  // per-scope (a combined request fails as a whole if any scope lacks
  // consent). Batched to keep concurrent token-endpoint calls modest.
  const results: ScopeTestResult[] = [];
  for (let i = 0; i < M365_SCOPES.length; i += TOKEN_MINT_CONCURRENCY) {
    const batch = M365_SCOPES.slice(i, i + TOKEN_MINT_CONCURRENCY);
    results.push(
      ...(await Promise.all(batch.map((def) => testScope(req, def)))),
    );
  }

  const granted = results.filter((r) => r.status === 'granted');
  return successResponse({
    user: session.user.mail ?? session.user.id,
    summary: {
      granted: granted.length,
      consentMissing: results.filter((r) => r.status === 'consent_missing')
        .length,
      errors: results.filter((r) => r.status === 'error').length,
      probesFailed: granted.filter((r) => r.probe && !r.probe.ok).length,
    },
    results,
  });
}
