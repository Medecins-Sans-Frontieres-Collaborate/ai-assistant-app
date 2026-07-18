/**
 * AES-GCM cipher envelope for one backup blob (a conversation, or the
 * folders array). Isomorphic — runs in browsers and Node ≥ 20, both of which
 * provide WebCrypto, CompressionStream, Blob, and Response as globals.
 *
 * Binding, not just secrecy: the AAD `"cbk1|" + keyId + "|" + epoch + "|" +
 * conversationId` cryptographically ties each ciphertext to its key
 * generation, rotation epoch, and manifest slot — a blob swapped between
 * conversations, replayed from an earlier epoch, or re-labeled with a
 * different keyId fails GCM authentication even though the key would decrypt
 * it. Plaintext is gzipped before encryption (compress-then-encrypt; the
 * corpus is user-authored JSON with no attacker-controlled-secret mixing, so
 * compression-oracle attacks do not apply).
 */

/* global CompressionStream, DecompressionStream -- in the shared eslint
   globals list neither is declared; both are global in Node ≥ 20 and all
   target browsers. */

export interface CipherEnvelopeV1 {
  v: 1;
  alg: 'A256GCM';
  /** Fingerprint of the master key that produced `ct` (16 hex chars). */
  keyId: string;
  /** Key-rotation epoch this blob was written under. */
  epoch: number;
  /** Base64, 12 bytes, fresh per encryption. */
  iv: string;
  /** Base64 ciphertext + GCM tag. */
  ct: string;
  /** Present when the plaintext was compressed before encryption. */
  zip?: 'gzip';
}

/** The envelope names a different key than the one this device holds. */
export class EnvelopeKeyMismatchError extends Error {
  constructor(
    public readonly envelopeKeyId: string,
    public readonly expectedKeyId: string,
  ) {
    super(
      `envelope encrypted with key ${envelopeKeyId}, expected ${expectedKeyId}`,
    );
    this.name = 'EnvelopeKeyMismatchError';
  }
}

/** Ciphertext, AAD binding, or compressed payload failed verification. */
export class EnvelopeIntegrityError extends Error {
  constructor(message = 'envelope failed integrity verification') {
    super(message);
    this.name = 'EnvelopeIntegrityError';
  }
}

/** Envelope version or algorithm this build does not understand. */
export class EnvelopeVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeVersionError';
  }
}

const IV_BYTES = 12;
const AAD_DOMAIN = 'cbk1';

function buildAad(
  keyId: string,
  epoch: number,
  conversationId: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `${AAD_DOMAIN}|${keyId}|${epoch}|${conversationId}`,
  );
}

/** Chunked to avoid blowing the argument-spread stack on multi-MB blobs. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

async function gzip(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface EncryptEnvelopeParams {
  /** Usually `JSON.stringify(conversation)`. */
  plaintext: string;
  /** Non-extractable AES-GCM key from `deriveBackupKeys`. */
  encKey: CryptoKey;
  keyId: string;
  epoch: number;
  /** Manifest slot id (`'folders'` for the folders blob). */
  conversationId: string;
}

export async function encryptEnvelope(
  params: EncryptEnvelopeParams,
): Promise<CipherEnvelopeV1> {
  const { plaintext, encKey, keyId, epoch, conversationId } = params;
  const compressed = await gzip(new TextEncoder().encode(plaintext));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: buildAad(keyId, epoch, conversationId),
      },
      encKey,
      compressed,
    ),
  );
  return {
    v: 1,
    alg: 'A256GCM',
    keyId,
    epoch,
    iv: toBase64(iv),
    ct: toBase64(ciphertext),
    zip: 'gzip',
  };
}

export interface DecryptEnvelopeParams {
  envelope: CipherEnvelopeV1;
  encKey: CryptoKey;
  /** keyId of the key this device holds; mismatch fails before any decrypt. */
  keyId: string;
  /** Manifest slot this blob was fetched for — part of the AAD binding. */
  conversationId: string;
}

/**
 * Verification order: version → algorithm → keyId (cheap, pre-crypto) →
 * GCM decrypt with AAD → gunzip. The envelope's own `epoch` feeds the AAD,
 * so a tampered epoch fails authentication rather than needing a check here.
 */
export async function decryptEnvelope(
  params: DecryptEnvelopeParams,
): Promise<string> {
  const { envelope, encKey, keyId, conversationId } = params;
  if (envelope.v !== 1) {
    throw new EnvelopeVersionError(
      `unsupported envelope version ${envelope.v}`,
    );
  }
  if (envelope.alg !== 'A256GCM') {
    throw new EnvelopeVersionError(
      `unsupported envelope algorithm ${envelope.alg}`,
    );
  }
  if (envelope.keyId !== keyId) {
    throw new EnvelopeKeyMismatchError(envelope.keyId, keyId);
  }

  let plainBytes: Uint8Array;
  try {
    plainBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: fromBase64(envelope.iv),
          additionalData: buildAad(keyId, envelope.epoch, conversationId),
        },
        encKey,
        fromBase64(envelope.ct),
      ),
    );
  } catch {
    // WebCrypto reports GCM failure as an opaque OperationError by design.
    throw new EnvelopeIntegrityError();
  }

  if (envelope.zip === 'gzip') {
    try {
      plainBytes = await gunzip(plainBytes);
    } catch {
      throw new EnvelopeIntegrityError('authenticated payload failed gunzip');
    }
  }
  return new TextDecoder().decode(plainBytes);
}
