/**
 * Short-lived signed tokens (HMAC over blob path + expiry) that let the
 * Office Online viewer fetch grant documents through the app's public
 * viewer-fetch route — the storage account itself is network-restricted.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_TTL_SECONDS = 15 * 60;

function secret(): string {
  const s = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error('AUTH_SECRET/NEXTAUTH_SECRET not configured');
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sign(payload: string): string {
  return b64url(createHmac('sha256', secret()).update(payload).digest());
}

export function mintDocToken(
  blobPath: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  const payload = b64url(
    Buffer.from(
      JSON.stringify({ p: blobPath, e: Date.now() + ttlSeconds * 1000 }),
    ),
  );
  return `${payload}.${sign(payload)}`;
}

// Returns the blob path when valid and unexpired, else null.
export function verifyDocToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { p, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof p !== 'string' || typeof e !== 'number') return null;
    if (Date.now() > e) return null;
    return p;
  } catch {
    return null;
  }
}
