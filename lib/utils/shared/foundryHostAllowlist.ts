import { env } from '@/config/environment';

/**
 * Strict host allow-list for Foundry endpoints. We only ever attach a user's
 * Foundry-scoped OBO token to URLs whose host matches this allow-list — anything
 * else risks leaking the bearer token to an attacker-controlled host.
 *
 * Allowed:
 *   - Hosts ending in `.services.ai.azure.com` (Foundry data plane)
 *   - Hosts ending in `.cognitiveservices.azure.com` (Cognitive Services data plane)
 *   - Hosts that exactly match the configured AZURE_AI_FOUNDRY_ENDPOINT_{US,EU,default}
 */
const ALLOWED_HOST_SUFFIXES = [
  '.services.ai.azure.com',
  '.cognitiveservices.azure.com',
] as const;

function configuredHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const url of [
    env.AZURE_AI_FOUNDRY_ENDPOINT,
    env.AZURE_AI_FOUNDRY_ENDPOINT_US,
    env.AZURE_AI_FOUNDRY_ENDPOINT_EU,
  ]) {
    if (!url) continue;
    try {
      hosts.add(new URL(url).host.toLowerCase());
    } catch {
      // Skip malformed env values — they were never going to work anyway.
    }
  }
  return hosts;
}

export function isAllowedFoundryHost(urlOrHost: string): boolean {
  if (typeof urlOrHost !== 'string' || urlOrHost.length === 0) return false;

  let host: string;
  try {
    if (urlOrHost.startsWith('http://') || urlOrHost.startsWith('https://')) {
      const parsed = new URL(urlOrHost);
      // Refuse plaintext — bearer tokens must never traverse http://.
      if (parsed.protocol !== 'https:') return false;
      host = parsed.host.toLowerCase();
    } else {
      host = urlOrHost.toLowerCase();
    }
  } catch {
    return false;
  }

  if (host.length === 0) return false;

  if (configuredHosts().has(host)) return true;

  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
}
