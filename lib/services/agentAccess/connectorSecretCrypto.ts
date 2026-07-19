/**
 * Envelope encryption for admin-authored MCP connector OAuth client secrets.
 *
 * Unlike every other credential in the MCP stack, a connector's OAuth client
 * secret is a DEPLOYMENT secret that must live server-side at rest (blob
 * storage) so the token proxy can inject it — it cannot ride in the per-user
 * client vault (client/services/mcp/credentialVault.ts). This module is the
 * only thing that puts it there, and it never stores plaintext.
 *
 * Key: HKDF(AUTH_SECRET, info='connector-oauth-client-secret') — the same
 * stateless posture as /api/mcp/vault-key, no new key management surface.
 * Rotating AUTH_SECRET makes existing sealed secrets undecryptable; that
 * surfaces as a re-enter-the-secret prompt, never as a crash.
 *
 * AAD binds each ciphertext to its connector id, so a sealed secret copied
 * onto a different connector record (by a blob edit, or a bug in the store)
 * fails GCM authentication instead of silently authenticating the wrong
 * server.
 *
 * NOTE the deliberate asymmetry with the rest of the feature: when
 * AUTH_SECRET is absent this module refuses to seal rather than degrading to
 * plaintext. Callers must treat that as "the OAuth connector style is
 * unavailable on this deployment" and say so in the UI.
 */
import { SealedSecret } from '@/lib/services/agentAccess/types';

import { env } from '@/config/environment';
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const HKDF_SALT = 'mcp-connector-secret-v1';
const HKDF_INFO = 'connector-oauth-client-secret';
const AAD_DOMAIN = 'mcpc1';

/**
 * Raised when a seal/unseal is attempted on a deployment with no AUTH_SECRET.
 * Callers turn this into a disabled affordance plus an explanatory message —
 * never a silent plaintext fallback.
 */
export class ConnectorSecretUnconfiguredError extends Error {
  constructor() {
    super(
      'Connector OAuth secrets require AUTH_SECRET (or NEXTAUTH_SECRET) to be configured',
    );
    this.name = 'ConnectorSecretUnconfiguredError';
  }
}

/** A stored secret could not be decrypted — wrong key generation, or tampering. */
export class ConnectorSecretIntegrityError extends Error {
  constructor(message = 'sealed connector secret failed verification') {
    super(message);
    this.name = 'ConnectorSecretIntegrityError';
  }
}

function getServerSecret(): string | undefined {
  return env.AUTH_SECRET ?? env.NEXTAUTH_SECRET;
}

/**
 * Whether this deployment can store connector OAuth secrets at all. The admin
 * API and UI gate the OAuth auth style on this: with no server secret there
 * is no safe place to put a client secret, so the option is disabled and
 * explained rather than offered and then failed.
 */
export function isConnectorSecretCryptoConfigured(): boolean {
  return Boolean(getServerSecret());
}

function deriveKey(): Buffer {
  const serverSecret = getServerSecret();
  if (!serverSecret) throw new ConnectorSecretUnconfiguredError();
  return Buffer.from(
    hkdfSync('sha256', serverSecret, HKDF_SALT, HKDF_INFO, KEY_BYTES),
  );
}

function buildAad(connectorId: string): Buffer {
  return Buffer.from(`${AAD_DOMAIN}|${connectorId}`, 'utf8');
}

/** Encrypts a client secret for storage against `connectorId`. */
export function sealConnectorSecret(
  connectorId: string,
  plaintext: string,
): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  cipher.setAAD(buildAad(connectorId));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    // Tag appended so the envelope stays a single opaque field.
    ct: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64'),
  };
}

/**
 * Decrypts a sealed secret. Throws ConnectorSecretIntegrityError for anything
 * that fails authentication — including the expected case of a rotated
 * AUTH_SECRET, which callers surface as "re-enter the client secret".
 */
export function unsealConnectorSecret(
  connectorId: string,
  sealed: SealedSecret,
): string {
  const key = deriveKey();
  const raw = Buffer.from(sealed.ct, 'base64');
  if (raw.length <= TAG_BYTES) {
    throw new ConnectorSecretIntegrityError('sealed secret is truncated');
  }
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(0, raw.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(sealed.iv, 'base64'),
    );
    decipher.setAAD(buildAad(connectorId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    // Never propagate the underlying OpenSSL message — it varies by cause and
    // reaching a client would be a (small) oracle.
    throw new ConnectorSecretIntegrityError(
      error instanceof Error && error.name === 'ConnectorSecretIntegrityError'
        ? error.message
        : undefined,
    );
  }
}
