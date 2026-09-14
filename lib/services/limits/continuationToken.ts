/**
 * Signed proof that a tool-loop CONTINUATION round was issued by this server.
 *
 * The chat pipeline meters only round 0 of a native MCP tool loop — a
 * consent pause and its resume are one logical message, and charging every
 * round would make one question cost five. But the server is stateless and
 * the round counter (`mcpLoopRound`) comes from the request body, so before
 * this token existed ANY signed-in user could post `mcpLoopRound: 1` with no
 * MCP servers at all and receive an unmetered completion (chat/model
 * counters and the token pre-flight all skipped).
 *
 * Every approval card the tool loop emits now carries a token bound to the
 * user and that card's approval id; the client echoes it on resume inside
 * `mcpPendingToolCalls[].continuationToken`. The limits middleware treats a
 * round as a continuation ONLY when every pending call carries a token that
 * verifies for the caller. Anything else is simply metered as a new message
 * — never rejected — so an older client, a hand-crafted request, or an
 * expired token costs one message rather than breaking the loop.
 *
 * Replay: a token is valid for {@link CONTINUATION_TOKEN_TTL_MS} and re-
 * executes the same approved tool calls; that bounds a replay to what the
 * user already paid one message for, within a short window.
 *
 * HMAC-SHA256 over `v1|userId|approvalRequestId|expiresAt` with the auth
 * secret (the same secret the chunked-upload session signer uses). With no
 * secret configured nothing is minted, so continuations are metered — the
 * safe direction.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONTINUATION_TOKEN_TTL_MS = 30 * 60 * 1000;

const VERSION = 'v1';

function signingSecret(): string | null {
  return process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || null;
}

function signature(
  secret: string,
  userId: string,
  approvalRequestId: string,
  expiresAt: number,
): string {
  return createHmac('sha256', secret)
    .update([VERSION, userId, approvalRequestId, String(expiresAt)].join('|'))
    .digest('base64url');
}

/**
 * Mints a token for one approval card, or null when no secret is configured
 * (or the identity is empty — nothing to bind to).
 */
export function mintContinuationToken(
  userId: string,
  approvalRequestId: string,
  now: number = Date.now(),
): string | null {
  const secret = signingSecret();
  if (!secret || !userId || !approvalRequestId) return null;
  const expiresAt = now + CONTINUATION_TOKEN_TTL_MS;
  return `${VERSION}.${expiresAt}.${signature(secret, userId, approvalRequestId, expiresAt)}`;
}

/** True only for an unexpired token minted for exactly this user and card. */
export function verifyContinuationToken(
  userId: string,
  approvalRequestId: string,
  token: string | undefined,
  now: number = Date.now(),
): boolean {
  const secret = signingSecret();
  if (!secret || !userId || !approvalRequestId || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  const expected = Buffer.from(
    signature(secret, userId, approvalRequestId, expiresAt),
  );
  const given = Buffer.from(parts[2]);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The limits middleware's question: is this round a server-issued
 * continuation? Requires a round above 0, at least one pending call, at
 * least one server, and a verifying token on EVERY pending call.
 */
export function isVerifiedContinuation(
  userId: string,
  round: number | undefined,
  pendingCalls:
    | ReadonlyArray<{ id: string; continuationToken?: string }>
    | undefined,
  serverCount: number,
  now: number = Date.now(),
): boolean {
  if ((round ?? 0) <= 0) return false;
  if (!pendingCalls?.length || serverCount <= 0) return false;
  return pendingCalls.every((call) =>
    verifyContinuationToken(userId, call.id, call.continuationToken, now),
  );
}
