import { env } from '@/config/environment';
import officesConfig from '@/config/offices.json';

export type UserRegion = 'US' | 'EU';

interface RawOffice {
  id: string;
  displayName: string;
  emailDomains: string[];
  region: UserRegion;
  /** Names of env vars that hold comma-separated ARM resource paths */
  foundryProjectsEnv: string[];
}

export interface Office {
  id: string;
  displayName: string;
  region: UserRegion;
  /** ARM resource paths to Foundry projects whose agents auto-discover for this office */
  foundryProjects: string[];
}

/**
 * Office-scoped agent discovery.
 *
 * Each office defines:
 *  - a region (for GDPR data residency routing — US or EU)
 *  - email domain patterns (to match users to their office)
 *  - one or more Foundry project resource IDs (whose agents are discovered automatically)
 *
 * Users still get the global default endpoints (AZURE_AI_FOUNDRY_ENDPOINT_{US,EU}) as
 * fallback. Custom sources users add manually take precedence over their office defaults.
 */
export class OfficeResolver {
  private static officesCache: Office[] | null = null;

  /**
   * Resolves all configured offices, hydrating env-var-backed project IDs.
   */
  static getAllOffices(): Office[] {
    if (OfficeResolver.officesCache) return OfficeResolver.officesCache;

    const raw = (officesConfig as { offices: RawOffice[] }).offices ?? [];
    OfficeResolver.officesCache = raw.map((o) => ({
      id: o.id,
      displayName: o.displayName,
      region: o.region,
      foundryProjects: o.foundryProjectsEnv
        .flatMap((envName) => (process.env[envName] ?? '').split(','))
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    }));
    return OfficeResolver.officesCache;
  }

  /**
   * Finds the office matching a user's email. Returns null if no match.
   * Match is by email domain — exact match or subdomain match.
   */
  static findOfficeByEmail(email: string | undefined | null): Office | null {
    if (!email) return null;
    const domain = email.toLowerCase().split('@')[1];
    if (!domain) return null;

    const raw = (officesConfig as { offices: RawOffice[] }).offices ?? [];
    const offices = OfficeResolver.getAllOffices();

    // Score-based: prefer the most specific (longest) domain match
    let best: { office: Office; score: number } | null = null;
    for (let i = 0; i < raw.length; i++) {
      const cfg = raw[i];
      for (const d of cfg.emailDomains) {
        const dl = d.toLowerCase();
        if (domain === dl || domain.endsWith('.' + dl)) {
          const score = dl.length;
          if (!best || score > best.score) {
            best = { office: offices[i], score };
          }
        }
      }
    }

    return best?.office ?? null;
  }

  /**
   * Returns the user's region — derived from their office, or falls back to
   * the legacy "newyork" email substring check, or 'EU' as the global default.
   */
  static getRegionForUser(email: string | undefined | null): UserRegion {
    const office = OfficeResolver.findOfficeByEmail(email);
    if (office) return office.region;
    if (email && email.toLowerCase().includes('newyork')) return 'US';
    return 'EU';
  }

  /**
   * Returns the Foundry endpoint URL for a user — uses regional default since
   * all offices in a given region share the same data plane endpoint.
   */
  static getFoundryEndpoint(region: UserRegion): string {
    if (region === 'EU' && env.AZURE_AI_FOUNDRY_ENDPOINT_EU) {
      return env.AZURE_AI_FOUNDRY_ENDPOINT_EU;
    }
    if (region === 'US' && env.AZURE_AI_FOUNDRY_ENDPOINT_US) {
      return env.AZURE_AI_FOUNDRY_ENDPOINT_US;
    }
    const fallback = env.AZURE_AI_FOUNDRY_ENDPOINT;
    if (!fallback) {
      throw new Error(
        `No Azure AI Foundry endpoint configured for region: ${region}`,
      );
    }
    return fallback;
  }

  /**
   * Returns categorized discovery paths for a user:
   *   - regionalPath: the global default Foundry project for the user's region
   *   - officePaths: any office-specific Foundry projects (deduplicated from regional)
   *
   * The client uses these to render separate sections in the UI:
   *   "Region Agents" | "{Office Name} Agents" | "Custom Agents"
   */
  static getDiscoveryPathsForUser(email: string | undefined | null): {
    regionalPath: string | null;
    officePaths: string[];
  } {
    const office = OfficeResolver.findOfficeByEmail(email);
    const region = office?.region ?? OfficeResolver.getRegionForUser(email);

    const regional =
      region === 'US'
        ? env.AZURE_AI_FOUNDRY_RESOURCE_ID_US
        : env.AZURE_AI_FOUNDRY_RESOURCE_ID_EU;

    const officePaths = (office?.foundryProjects ?? []).filter(
      (p) => p !== regional,
    );

    return {
      regionalPath: regional ?? null,
      officePaths,
    };
  }

  /** Test/dev helper to bust the cache after env changes. */
  static reset(): void {
    OfficeResolver.officesCache = null;
  }
}
