/**
 * Repository identity for the public GitHub releases feed.
 *
 * Shared by the server (which fetches the feed) and the client (which needs a
 * fallback "view on GitHub" link even when the server could not answer at
 * all). Kept free of `process.env` reads so it is safe to import in a client
 * component; the server layer applies the env override on top of it.
 */

/** The project's public repository. */
export const DEFAULT_RELEASES_REPO =
  'Medecins-Sans-Frontieres-Collaborate/ai-assistant-app';

/** `owner/name`, the only shape GitHub accepts and the only one we build URLs from. */
export const REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Human-facing releases page for a repo slug. */
export function githubReleasesUrl(
  slug: string = DEFAULT_RELEASES_REPO,
): string {
  return `https://github.com/${slug}/releases`;
}
