import type { ChainedTokenCredential } from '@azure/identity';

/**
 * Builds the app's own identity credential chain — managed identity in Azure,
 * Azure CLI locally. Used as a dev-only fallback when the per-user OBO flow is
 * unavailable; production paths must fail closed rather than fall back to this
 * (the app identity has broader RBAC than any single user).
 *
 * `@azure/identity` is imported dynamically so it isn't bundled where unused.
 */
export async function createAppIdentityCredential(): Promise<ChainedTokenCredential> {
  const {
    ChainedTokenCredential,
    AzureCliCredential,
    ManagedIdentityCredential,
  } = await import('@azure/identity');
  return new ChainedTokenCredential(
    new ManagedIdentityCredential(),
    new AzureCliCredential(),
  );
}
