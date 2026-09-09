/**
 * Opaque pagination tokens for the M365 drive/mail routes. Graph returns an
 * `@odata.nextLink` URL for the next page; replaying an arbitrary
 * client-supplied URL server-side would be an SSRF hole, so the link is
 * base64url-wrapped into a token and re-validated against graph.microsoft.com
 * on the way back in. The same predicate guards both directions, and decoded
 * links are never logged (they can embed query text and item ids).
 */

/** Hard cap on token size, applied on encode and decode alike. */
const MAX_TOKEN_LENGTH = 6144;

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

/** True only for URLs this server is willing to replay against Graph. */
function isReplayableGraphUrl(nextLink: string): boolean {
  let url: URL;
  try {
    url = new URL(nextLink);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === 'graph.microsoft.com' &&
    url.pathname.startsWith('/v1.0/')
  );
}

/**
 * Wraps a Graph `@odata.nextLink` into an opaque continuation token.
 * Returns undefined when the link is not a replayable Graph URL (or the
 * encoded token would exceed the size cap) — callers then omit `nextToken`
 * rather than surface a broken page cursor.
 */
export function encodeGraphNextLink(nextLink: string): string | undefined {
  if (!isReplayableGraphUrl(nextLink)) return undefined;
  const token = Buffer.from(nextLink, 'utf8').toString('base64url');
  if (token.length > MAX_TOKEN_LENGTH) return undefined;
  return token;
}

/**
 * Unwraps a client-echoed continuation token back into a Graph URL.
 * Returns null for anything that is not a token this server could have
 * produced: oversize, non-base64url, or decoding to a URL outside
 * https://graph.microsoft.com/v1.0/.
 */
export function decodeGraphPageToken(token: string): string | null {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  if (!BASE64URL_REGEX.test(token)) return null;
  const nextLink = Buffer.from(token, 'base64url').toString('utf8');
  return isReplayableGraphUrl(nextLink) ? nextLink : null;
}
