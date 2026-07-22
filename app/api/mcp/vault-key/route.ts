import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import {
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { hkdfSync } from 'node:crypto';

/**
 * GET /api/mcp/vault-key — per-user key material for the client-side MCP
 * credential vault (client/services/mcp/credentialVault.ts).
 *
 * The server derives 32 bytes via HKDF(server secret, info=userId) and
 * STORES NOTHING — same stateless posture as the rest of /api/mcp. The
 * client combines this with a device-local random salt to derive a
 * non-extractable AES-GCM key, so MCP credentials at rest on the device are
 * ciphertext that is useless without an authenticated session here.
 *
 * Threat-model note (documented, not accidental): this does NOT defend
 * against same-origin XSS — an attacker running code in the origin can call
 * this endpoint like the app does. It defends the at-rest artifact: a copied
 * browser profile, a localStorage/IndexedDB dump, or a backup sweep yields
 * only ciphertext. Rotating the server secret (or a changed user id)
 * invalidates existing vaults — clients degrade to "reconnect", never crash.
 */

const limiter = RateLimiter.createScoped(30, 1);

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userId = session.user.id ?? session.user.mail;
  if (!userId) return unauthorizedResponse();

  if (!limiter.checkLimit(userId).allowed) {
    return errorResponse('Too many requests', 429, undefined, 'RATE_LIMITED');
  }

  const serverSecret = env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;
  if (!serverSecret) {
    return errorResponse(
      'Credential vault requires AUTH_SECRET to be configured',
      503,
      undefined,
      'VAULT_UNCONFIGURED',
    );
  }

  const keyMaterial = Buffer.from(
    hkdfSync(
      'sha256',
      serverSecret,
      'mcp-credential-vault-v1', // salt: fixed, versioned
      `user:${userId}`, // info: binds the key to this user
      32,
    ),
  );

  return successResponse(
    { keyMaterial: keyMaterial.toString('base64'), version: 1 },
    undefined,
    200,
  );
}
