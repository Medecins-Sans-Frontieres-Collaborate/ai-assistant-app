import {
  ConfidentialClientApplication,
  OnBehalfOfRequest,
} from '@azure/msal-node';

const FOUNDRY_SCOPE = 'https://ai.azure.com/user_impersonation';
const ARM_SCOPE = 'https://management.azure.com/.default';

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Provides per-user OBO (On-Behalf-Of) tokens for Azure AI Foundry and ARM API calls.
 *
 * Uses the user's access token (scoped to the app's own audience) as an assertion
 * to acquire delegated tokens for downstream services:
 * - Foundry: for agent invocations as the user
 * - ARM: for agent discovery (RBAC-filtered)
 *
 * Tokens are cached per-user with a 5-minute safety buffer before expiry.
 */
export class UserTokenProvider {
  private static instance: UserTokenProvider | null = null;
  private tokenCache = new Map<string, CachedToken>();
  private msalClient: ConfidentialClientApplication;

  private constructor() {
    this.msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.AZURE_CLIENT_ID || '',
        clientSecret: process.env.AZURE_CLIENT_SECRET || '',
        authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
      },
    });
  }

  static getInstance(): UserTokenProvider {
    if (!UserTokenProvider.instance) {
      UserTokenProvider.instance = new UserTokenProvider();
    }
    return UserTokenProvider.instance;
  }

  /**
   * Acquires a Foundry-scoped OBO token for calling AI Foundry as the user.
   * Scope: https://ai.azure.com/user_impersonation
   */
  async getFoundryToken(userAccessToken: string): Promise<string> {
    return this.getOboToken(userAccessToken, FOUNDRY_SCOPE, 'foundry');
  }

  /**
   * Acquires an ARM-scoped OBO token for calling the Azure Resource Manager API.
   * Used for agent discovery (listAgents filtered by RBAC).
   * Scope: https://management.azure.com/.default
   */
  async getArmToken(userAccessToken: string): Promise<string> {
    return this.getOboToken(userAccessToken, ARM_SCOPE, 'arm');
  }

  private async getOboToken(
    userAccessToken: string,
    scope: string,
    purpose: string,
  ): Promise<string> {
    // Create a cache key from a hash of the token + scope
    const cacheKey = `${this.hashToken(userAccessToken)}:${purpose}`;

    // Check cache (with 5-minute safety buffer)
    const cached = this.tokenCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
      return cached.token;
    }

    const oboRequest: OnBehalfOfRequest = {
      oboAssertion: userAccessToken,
      scopes: [scope],
    };

    const result = await this.msalClient.acquireTokenOnBehalfOf(oboRequest);

    if (!result || !result.accessToken) {
      throw new Error(
        `Failed to acquire OBO token for ${purpose}: no token returned`,
      );
    }

    // Cache the token
    this.tokenCache.set(cacheKey, {
      token: result.accessToken,
      expiresAt: result.expiresOn
        ? result.expiresOn.getTime()
        : Date.now() + 60 * 60 * 1000, // Default 1 hour
    });

    return result.accessToken;
  }

  /**
   * Simple hash for cache key derivation. Not cryptographic — just for map lookups.
   */
  private hashToken(token: string): string {
    let hash = 0;
    for (let i = 0; i < Math.min(token.length, 100); i++) {
      const char = token.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  /**
   * Clears expired tokens from cache.
   * Call periodically to prevent memory leaks.
   */
  cleanupCache(): void {
    const now = Date.now();
    for (const [key, value] of this.tokenCache) {
      if (now >= value.expiresAt) {
        this.tokenCache.delete(key);
      }
    }
  }

  static reset(): void {
    UserTokenProvider.instance = null;
  }
}
