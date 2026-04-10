import { NextRequest, NextResponse } from 'next/server';

import { UserTokenProvider } from '@/lib/services/auth/UserTokenProvider';

import { auth, getAccessTokenForOBO } from '@/auth';

const ARM_BASE = 'https://management.azure.com';

async function getArmToken(session: any): Promise<string> {
  try {
    const appAccessToken = await getAccessTokenForOBO(session);
    if (!appAccessToken) throw new Error('No OBO token');
    const tokenProvider = UserTokenProvider.getInstance();
    return await tokenProvider.getArmToken(appAccessToken);
  } catch {
    const {
      ChainedTokenCredential,
      AzureCliCredential,
      ManagedIdentityCredential,
    } = await import('@azure/identity');
    const credential = new ChainedTokenCredential(
      new ManagedIdentityCredential(),
      new AzureCliCredential(),
    );
    const tokenResponse = await credential.getToken(
      'https://management.azure.com/.default',
    );
    return tokenResponse.token;
  }
}

async function armGet(token: string, url: string) {
  const response = await fetch(url, {
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
  return response.json();
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
    const armToken = await getArmToken(session);
    const level = request.nextUrl.searchParams.get('level');

    if (level === 'subscriptions') {
      const data = await armGet(
        armToken,
        `${ARM_BASE}/subscriptions?api-version=2022-01-01`,
      );
      const subs = (data.value || []).map((s: any) => ({
        id: s.subscriptionId,
        name: s.displayName,
      }));
      return NextResponse.json({ items: subs });
    }

    if (level === 'accounts') {
      const subscriptionId = request.nextUrl.searchParams.get('subscriptionId');
      if (!subscriptionId) {
        return NextResponse.json(
          { error: 'subscriptionId required' },
          { status: 400 },
        );
      }
      const url = `${ARM_BASE}/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=2025-12-01`;
      const data = await armGet(armToken, url);
      const allAccounts = data.value || [];
      const accounts = allAccounts
        .filter((a: any) => a.kind === 'AIServices')
        .map((a: any) => ({
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
      if (!subscriptionId || !resourceGroup || !accountName) {
        return NextResponse.json(
          { error: 'subscriptionId, resourceGroup, accountName required' },
          { status: 400 },
        );
      }
      const data = await armGet(
        armToken,
        `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${accountName}/projects?api-version=2025-12-01`,
      );
      const projects = (data.value || []).map((p: any) => ({
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
