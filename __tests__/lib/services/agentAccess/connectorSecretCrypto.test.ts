import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  AUTH_SECRET: undefined as string | undefined,
  NEXTAUTH_SECRET: undefined as string | undefined,
}));

vi.mock('@/config/environment', () => ({ env: mockEnv }));

const {
  ConnectorSecretIntegrityError,
  ConnectorSecretUnconfiguredError,
  isConnectorSecretCryptoConfigured,
  sealConnectorSecret,
  unsealConnectorSecret,
} = await import('@/lib/services/agentAccess/connectorSecretCrypto');
const { SealedSecretSchema } = await import('@/lib/services/agentAccess/types');

describe('connectorSecretCrypto', () => {
  beforeEach(() => {
    mockEnv.AUTH_SECRET = 'server-secret-for-tests';
    mockEnv.NEXTAUTH_SECRET = undefined;
  });

  it('round-trips a client secret', () => {
    const sealed = sealConnectorSecret('conn-1', 'super-secret-value');

    expect(SealedSecretSchema.safeParse(sealed).success).toBe(true);
    expect(unsealConnectorSecret('conn-1', sealed)).toBe('super-secret-value');
  });

  it('never stores the plaintext in the envelope', () => {
    const sealed = sealConnectorSecret('conn-1', 'super-secret-value');

    expect(JSON.stringify(sealed)).not.toContain('super-secret-value');
  });

  it('uses a fresh IV per seal, so identical secrets differ as ciphertext', () => {
    const a = sealConnectorSecret('conn-1', 'same');
    const b = sealConnectorSecret('conn-1', 'same');

    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('refuses to unseal against a different connector id (AAD binding)', () => {
    // A sealed secret lifted onto another connector record must not decrypt —
    // otherwise a blob edit could point one tenant's secret at another host.
    const sealed = sealConnectorSecret('conn-1', 'super-secret-value');

    expect(() => unsealConnectorSecret('conn-2', sealed)).toThrow(
      ConnectorSecretIntegrityError,
    );
  });

  it('refuses to unseal after the server secret rotates', () => {
    const sealed = sealConnectorSecret('conn-1', 'super-secret-value');
    mockEnv.AUTH_SECRET = 'a-completely-different-secret';

    expect(() => unsealConnectorSecret('conn-1', sealed)).toThrow(
      ConnectorSecretIntegrityError,
    );
  });

  it('detects tampered ciphertext', () => {
    const sealed = sealConnectorSecret('conn-1', 'super-secret-value');
    const raw = Buffer.from(sealed.ct, 'base64');
    raw[0] ^= 0xff;

    expect(() =>
      unsealConnectorSecret('conn-1', {
        ...sealed,
        ct: raw.toString('base64'),
      }),
    ).toThrow(ConnectorSecretIntegrityError);
  });

  it('rejects a truncated envelope rather than reading past the buffer', () => {
    expect(() =>
      unsealConnectorSecret('conn-1', {
        v: 1,
        alg: 'A256GCM',
        iv: Buffer.alloc(12).toString('base64'),
        ct: Buffer.alloc(4).toString('base64'),
      }),
    ).toThrow(ConnectorSecretIntegrityError);
  });

  it('falls back to NEXTAUTH_SECRET when AUTH_SECRET is absent', () => {
    mockEnv.AUTH_SECRET = undefined;
    mockEnv.NEXTAUTH_SECRET = 'legacy-secret';

    expect(isConnectorSecretCryptoConfigured()).toBe(true);
    const sealed = sealConnectorSecret('conn-1', 'value');
    expect(unsealConnectorSecret('conn-1', sealed)).toBe('value');
  });

  describe('with no server secret configured', () => {
    beforeEach(() => {
      mockEnv.AUTH_SECRET = undefined;
      mockEnv.NEXTAUTH_SECRET = undefined;
    });

    it('reports itself unconfigured so callers can disable the feature', () => {
      expect(isConnectorSecretCryptoConfigured()).toBe(false);
    });

    it('refuses to seal rather than degrading to plaintext', () => {
      expect(() => sealConnectorSecret('conn-1', 'value')).toThrow(
        ConnectorSecretUnconfiguredError,
      );
    });
  });
});
