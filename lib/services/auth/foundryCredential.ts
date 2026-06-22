import { AccessToken, TokenCredential } from '@azure/identity';

/**
 * Wraps a raw Foundry data-plane OBO access token as an Azure `TokenCredential`
 * for use with `AIProjectClient` and related SDK clients.
 *
 * The returned credential honors the SDK-requested scope so we never blindly
 * hand the Foundry token to any audience the SDK happens to ask for. Foundry
 * data-plane scopes are `https://ai.azure.com/...` (and the Cognitive Services
 * equivalent); any other requested scope is refused.
 *
 * Shared by the chat credential middleware (per-user agent invocation) and the
 * agent discovery service (data-plane agent listing) so both bind the OBO token
 * with identical, audited scope checks.
 */
export function createFoundryTokenCredential(
  foundryToken: string,
): TokenCredential {
  return {
    getToken: async (scopes) => {
      const requested = Array.isArray(scopes) ? scopes : [scopes];
      const ok = requested.some(
        (s) =>
          typeof s === 'string' &&
          (s.startsWith('https://ai.azure.com/') ||
            s.startsWith('https://cognitiveservices.azure.com/')),
      );
      if (!ok) {
        throw new Error(
          `[FoundryCredential] Refusing to issue Foundry token for scope: ${requested.join(',')}`,
        );
      }
      return {
        token: foundryToken,
        expiresOnTimestamp: Date.now() + 55 * 60 * 1000,
      } as AccessToken;
    },
  };
}
