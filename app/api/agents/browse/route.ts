import { NextRequest, NextResponse } from 'next/server';

import { UserTokenProvider } from '@/lib/services/auth/UserTokenProvider';
import { createAppIdentityCredential } from '@/lib/services/auth/appIdentityCredential';

import {
  isValidAccountName,
  isValidResourceGroup,
  isValidSubscriptionId,
} from '@/lib/utils/shared/armPath';

import { auth, getAccessTokenForOBO } from '@/auth';

const ARM_BASE = 'https://management.azure.com';

async function getArmToken(req: NextRequest): Promise<string> {
  try {
    const appAccessToken = await getAccessTokenForOBO(req);
    if (!appAccessToken) throw new Error('No OBO token');
    const tokenProvider = UserTokenProvider.getInstance();
    return await tokenProvider.getArmToken(appAccessToken);
  } catch (e) {
    // Fail closed in production: browsing must reflect the signed-in user's own
    // RBAC. The app's managed/CLI identity has broader access than any single
    // user, so falling back to it would expose resources the user can't see.
    // This mirrors the policy in /api/agents. The dev fallback is convenience
    // only (local machines typically lack a usable OBO flow).
    if (process.env.NODE_ENV === 'production') {
      throw e;
    }
    const credential = await createAppIdentityCredential();
    const tokenResponse = await credential.getToken(
      'https://management.azure.com/.default',
    );
    return tokenResponse.token;
  }
}

interface ArmSubscription {
  subscriptionId: string;
  displayName: string;
}

interface ArmCognitiveAccount {
  name: string;
  kind?: string;
  id: string;
  location?: string;
}

interface ArmProject {
  name: string;
}

async function armGet<T>(token: string, url: URL): Promise<{ value: T[] }> {
  // Defense-in-depth: callers build URLs from validated query params, but pin
  // the origin to ARM so a request can never be redirected to another host
  // (SSRF) even if a validator were later loosened.
  if (url.origin !== ARM_BASE) {
    console.error('[/api/agents/browse] Blocked non-ARM URL:', url.toString());
    return { value: [] };
  }
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(
      `[/api/agents/browse] ARM ${response.status}:`,
      body.substring(0, 200),
    );
    return { value: [] };
  }
  const data = (await response.json()) as { value?: T[] };
  return { value: data.value ?? [] };
}

/**
 * GET /api/agents/browse
 *
 * Browse Azure resources to build a Foundry project path.
 * Cascading: subscriptions → accounts → projects
 *
 * Query params:
 *   ?level=subscriptions
 *   ?level=accounts&subscriptionId=xxx
 *   ?level=projects&subscriptionId=xxx&resourceGroup=xxx&accountName=xxx
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const armToken = await getArmToken(request);
    const level = request.nextUrl.searchParams.get('level');

    if (level === 'subscriptions') {
      const data = await armGet<ArmSubscription>(
        armToken,
        new URL('/subscriptions?api-version=2022-01-01', ARM_BASE),
      );
      const subs = data.value.map((s) => ({
        id: s.subscriptionId,
        name: s.displayName,
      }));
      return NextResponse.json({ items: subs });
    }

    if (level === 'accounts') {
      const subscriptionId = request.nextUrl.searchParams.get('subscriptionId');
      if (!subscriptionId || !isValidSubscriptionId(subscriptionId)) {
        return NextResponse.json(
          { error: 'valid subscriptionId required' },
          { status: 400 },
        );
      }
      const url = new URL(
        `/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.CognitiveServices/accounts?api-version=2025-12-01`,
        ARM_BASE,
      );
      const data = await armGet<ArmCognitiveAccount>(armToken, url);
      const allAccounts = data.value;
      const accounts = allAccounts
        .filter((a) => a.kind === 'AIServices')
        .map((a) => ({
          name: a.name,
          resourceGroup: a.id.split('/resourceGroups/')[1]?.split('/')[0],
          location: a.location,
        }));
      console.log(
        `[/api/agents/browse] Accounts: ${allAccounts.length} total, ${accounts.length} AIServices`,
      );
      return NextResponse.json({ items: accounts });
    }

    if (level === 'projects') {
      const subscriptionId = request.nextUrl.searchParams.get('subscriptionId');
      const resourceGroup = request.nextUrl.searchParams.get('resourceGroup');
      const accountName = request.nextUrl.searchParams.get('accountName');
      if (
        !subscriptionId ||
        !resourceGroup ||
        !accountName ||
        !isValidSubscriptionId(subscriptionId) ||
        !isValidResourceGroup(resourceGroup) ||
        !isValidAccountName(accountName)
      ) {
        return NextResponse.json(
          {
            error: 'valid subscriptionId, resourceGroup, accountName required',
          },
          { status: 400 },
        );
      }
      const data = await armGet<ArmProject>(
        armToken,
        new URL(
          `/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.CognitiveServices/accounts/${encodeURIComponent(accountName)}/projects?api-version=2025-12-01`,
          ARM_BASE,
        ),
      );
      const projects = data.value.map((p) => ({
        name: p.name.split('/').pop(),
      }));
      return NextResponse.json({ items: projects });
    }

    return NextResponse.json(
      { error: 'level param required' },
      { status: 400 },
    );
  } catch (error) {
    console.error('[/api/agents/browse] Error:', error);
    return NextResponse.json({ items: [] });
  }
}
