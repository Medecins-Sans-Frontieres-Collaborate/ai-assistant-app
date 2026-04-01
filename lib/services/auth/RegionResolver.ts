import { env } from '@/config/environment';

type UserRegion = 'US' | 'EU';

/**
 * Resolves the correct regional Azure AI Foundry endpoint and ARM resource path
 * based on the user's region for GDPR data residency compliance.
 *
 * Data residency is per Foundry Resource — EU users are routed to the EU resource
 * (swedencentral) and US users to the US resource (eastus).
 *
 * Falls back to the default AZURE_AI_FOUNDRY_ENDPOINT if regional endpoints
 * are not configured (single-region deployment).
 */
export class RegionResolver {
  /**
   * Returns the Foundry project endpoint for the user's region.
   */
  static getFoundryEndpoint(userRegion: UserRegion): string {
    if (userRegion === 'EU' && env.AZURE_AI_FOUNDRY_ENDPOINT_EU) {
      return env.AZURE_AI_FOUNDRY_ENDPOINT_EU;
    }

    if (userRegion === 'US' && env.AZURE_AI_FOUNDRY_ENDPOINT_US) {
      return env.AZURE_AI_FOUNDRY_ENDPOINT_US;
    }

    // Fallback to default endpoint (single-region deployment)
    const defaultEndpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;
    if (!defaultEndpoint) {
      throw new Error(
        'No Azure AI Foundry endpoint configured for region: ' + userRegion,
      );
    }
    return defaultEndpoint;
  }

  /**
   * Returns the ARM resource path for the user's regional Foundry Resource.
   * Used for agent discovery via the ARM API.
   */
  static getArmResourcePath(userRegion: UserRegion): string | undefined {
    if (userRegion === 'EU') {
      return env.AZURE_AI_FOUNDRY_RESOURCE_ID_EU;
    }
    if (userRegion === 'US') {
      return env.AZURE_AI_FOUNDRY_RESOURCE_ID_US;
    }
    return undefined;
  }

  /**
   * Checks if multi-region routing is configured.
   */
  static isMultiRegionEnabled(): boolean {
    return !!(
      env.AZURE_AI_FOUNDRY_ENDPOINT_EU && env.AZURE_AI_FOUNDRY_ENDPOINT_US
    );
  }
}
