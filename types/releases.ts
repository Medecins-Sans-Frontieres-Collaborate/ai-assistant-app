/**
 * Release notes surfaced to users from the project's public GitHub releases.
 *
 * The repository is open source, so this is a pass-through of already-public
 * information; nothing here is derived from the signed-in user.
 */

/** A single published GitHub release, cleaned for display. */
export interface ReleaseNote {
  /** Git tag, e.g. `v2026.08.31`. Also the React key. */
  tag: string;
  /** Release title. Falls back to the tag when GitHub has no name. */
  name: string;
  /** ISO-8601 publish timestamp, or '' when GitHub omitted it. */
  publishedAt: string;
  /** Canonical GitHub URL for this release. */
  url: string;
  /** Markdown body with deploy/CI noise stripped. May be ''. */
  body: string;
}

/**
 * What `GET /api/releases` returns.
 *
 * `releasesUrl` is ALWAYS populated, including on failure, so the UI can
 * always offer the plain "view on GitHub" escape hatch. This surface must
 * never be able to break the update banner it hangs off, so failures are
 * reported as flags on a 200 rather than as error statuses.
 */
export interface ReleaseNotesPayload {
  releases: ReleaseNote[];
  releasesUrl: string;
  /** Served from an expired cache because a refresh failed. */
  stale?: boolean;
  /** Nothing could be fetched and nothing was cached — link only. */
  unavailable?: boolean;
}
