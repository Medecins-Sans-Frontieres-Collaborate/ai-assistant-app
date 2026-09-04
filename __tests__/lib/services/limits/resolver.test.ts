import {
  isBlocked,
  isUnlimited,
  resolveAllLimits,
  resolveLimit,
  resolveModelCells,
} from '@/lib/services/limits/resolver';
import {
  LimitEntry,
  LimitOverride,
  LimitsPolicy,
  LimitsPolicySchema,
  OverrideScope,
} from '@/lib/services/limits/types';
import { Principal } from '@/lib/services/shared/principalMatching';

import { getLimitDefinition } from '@/config/limits';
import { describe, expect, it } from 'vitest';

const CHAT_MESSAGES = getLimitDefinition('chat.messagesPerDay')!;
const MODEL_ALLOWED = getLimitDefinition('model.allowed')!;
const MODEL_REQUESTS = getLimitDefinition('model.requests')!;
const UPLOAD_MB = getLimitDefinition('feature.upload.megabytesPerFile')!;
const MCP_ROUNDS = getLimitDefinition('feature.mcp.roundsPerRequest')!;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'oid-1',
    mail: 'ada@example.org',
    domain: 'example.org',
    attributes: ['department:health', 'office:msf-usa'],
    groupIds: [],
    ...overrides,
  };
}

let idCounter = 0;
function override(
  scope: OverrideScope,
  targets: string[],
  entries: Partial<LimitEntry>[],
  extra: Partial<LimitOverride> = {},
): LimitOverride {
  idCounter += 1;
  const id = `lim-${idCounter.toString(16).padStart(12, '0')}`;
  return {
    id,
    label: '',
    enabled: true,
    scope,
    targets,
    priority: 0,
    entries: entries.map((e) => ({
      limitKey: 'chat.messagesPerDay',
      value: null,
      ceiling: false,
      ...e,
    })) as LimitEntry[],
    createdBy: 'admin',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function policy(
  defaults: Partial<LimitEntry>[],
  overrides: LimitOverride[] = [],
  extra: Partial<LimitsPolicy> = {},
): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults: defaults.map((e) => ({
      limitKey: 'chat.messagesPerDay',
      value: null,
      ceiling: false,
      ...e,
    })),
    overrides,
    updatedBy: 'admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
}

describe('resolveLimit — layers', () => {
  it('falls back to the compiled catalog default when nothing is configured', () => {
    const result = resolveLimit(CHAT_MESSAGES, null, principal());
    expect(result.value).toBeNull();
    expect(result.source).toBe('catalog');
    expect(isUnlimited(result)).toBe(true);
  });

  it('a global default beats the catalog', () => {
    const result = resolveLimit(
      CHAT_MESSAGES,
      policy([{ value: 100 }]),
      principal(),
    );
    expect(result).toMatchObject({ value: 100, source: 'global' });
  });

  it('applies layers in rank order: global < domain < attribute < user', () => {
    const p = policy(
      [{ value: 100 }],
      [
        override('domain', ['example.org'], [{ value: 200 }]),
        override('attribute', ['department:health'], [{ value: 300 }]),
        override('user', ['ada@example.org'], [{ value: 400 }]),
      ],
    );
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(400);

    // Drop the user layer → attribute wins.
    const noUser = policy(
      [{ value: 100 }],
      [
        override('domain', ['example.org'], [{ value: 200 }]),
        override('attribute', ['department:health'], [{ value: 300 }]),
      ],
    );
    expect(resolveLimit(CHAT_MESSAGES, noUser, principal()).value).toBe(300);

    // Drop attribute too → domain wins.
    const domainOnly = policy(
      [{ value: 100 }],
      [override('domain', ['example.org'], [{ value: 200 }])],
    );
    expect(resolveLimit(CHAT_MESSAGES, domainOnly, principal()).value).toBe(
      200,
    );
  });

  it('a user override may RAISE above a restrictive global default', () => {
    const p = policy(
      [{ value: 10 }],
      [override('user', ['ada@example.org'], [{ value: 5000 }])],
    );
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(5000);
    expect(result.source).toBe('user');
  });

  it('a user override may set unlimited (null) over a numeric global', () => {
    const p = policy(
      [{ value: 10 }],
      [override('user', ['ada@example.org'], [{ value: null }])],
    );
    expect(isUnlimited(resolveLimit(CHAT_MESSAGES, p, principal()))).toBe(true);
  });

  it('reports the winning override id as provenance', () => {
    const winning = override('user', ['ada@example.org'], [{ value: 42 }]);
    const p = policy([{ value: 10 }], [winning]);
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).overrideId).toBe(
      winning.id,
    );
  });
});

describe('resolveLimit — sparse merge', () => {
  it('an override that omits a key does not erase a lower layer for that key', () => {
    const p = policy(
      [],
      [
        override(
          'domain',
          ['example.org'],
          [{ limitKey: 'feature.tts.charactersPerDay', value: 1000 }],
        ),
        // Speaks ONLY to chat.messagesPerDay — must not touch the TTS limit.
        override(
          'user',
          ['ada@example.org'],
          [{ limitKey: 'chat.messagesPerDay', value: 50 }],
        ),
      ],
    );
    const tts = resolveLimit(
      getLimitDefinition('feature.tts.charactersPerDay')!,
      p,
      principal(),
    );
    expect(tts).toMatchObject({ value: 1000, source: 'domain' });
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(50);
  });

  it('distinguishes an explicit null (unlimited) from an absent key (inherit)', () => {
    const explicit = policy(
      [{ value: 10 }],
      [override('user', ['ada@example.org'], [{ value: null }])],
    );
    const absent = policy(
      [{ value: 10 }],
      [
        override(
          'user',
          ['ada@example.org'],
          [{ limitKey: 'feature.tts.charactersPerDay', value: 5 }],
        ),
      ],
    );
    expect(resolveLimit(CHAT_MESSAGES, explicit, principal()).value).toBeNull();
    expect(resolveLimit(CHAT_MESSAGES, absent, principal()).value).toBe(10);
  });
});

describe('resolveLimit — tie-breaks are total', () => {
  it('priority beats restrictiveness within a layer', () => {
    const p = policy(
      [],
      [
        override('domain', ['example.org'], [{ value: 10 }]),
        override('domain', ['example.org'], [{ value: 999 }], { priority: 5 }),
      ],
    );
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(999);
  });

  it('at equal rank and priority, the more restrictive value wins', () => {
    const p = policy(
      [],
      [
        override('domain', ['example.org'], [{ value: 900 }]),
        override('domain', ['example.org'], [{ value: 7 }]),
      ],
    );
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(7);
  });

  it('produces identical output under SHUFFLED override order', () => {
    const a = override('domain', ['example.org'], [{ value: 50 }]);
    const b = override('attribute', ['department:health'], [{ value: 20 }]);
    const c = override('user', ['ada@example.org'], [{ value: 80 }]);
    const orders = [
      [a, b, c],
      [c, b, a],
      [b, a, c],
      [c, a, b],
    ];
    const results = orders.map((overrides) =>
      resolveLimit(
        CHAT_MESSAGES,
        policy([{ value: 5 }], overrides),
        principal(),
      ),
    );
    for (const result of results) {
      expect(result.value).toBe(80);
      expect(result.overrideId).toBe(c.id);
    }
  });

  it('breaks a byte-identical tie by lexicographically smallest id', () => {
    const first = override('domain', ['example.org'], [{ value: 30 }]);
    const second = override('domain', ['example.org'], [{ value: 30 }]);
    const expected = [first.id, second.id].sort()[0];
    expect(
      resolveLimit(CHAT_MESSAGES, policy([], [first, second]), principal())
        .overrideId,
    ).toBe(expected);
    expect(
      resolveLimit(CHAT_MESSAGES, policy([], [second, first]), principal())
        .overrideId,
    ).toBe(expected);
  });
});

describe('resolveLimit — ceilings', () => {
  it('a global ceiling clamps an override that tries to exceed it', () => {
    const p = policy(
      [{ value: 100, ceiling: true }],
      [override('user', ['ada@example.org'], [{ value: 5000 }])],
    );
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(100);
    expect(result.ceilingApplied).toBe(true);
  });

  it('a global ceiling does not stop an override from going LOWER', () => {
    const p = policy(
      [{ value: 100, ceiling: true }],
      [override('user', ['ada@example.org'], [{ value: 5 }])],
    );
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(5);
    expect(result.ceilingApplied).toBeUndefined();
  });

  it('a global ceiling clamps an override that sets unlimited', () => {
    const p = policy(
      [{ value: 100, ceiling: true }],
      [override('user', ['ada@example.org'], [{ value: null }])],
    );
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(100);
  });

  it('the compiled hardCeiling can never be raised past', () => {
    const p = policy(
      [],
      [
        override(
          'user',
          ['ada@example.org'],
          [{ limitKey: MCP_ROUNDS.key, value: 999 }],
        ),
      ],
    );
    const result = resolveLimit(MCP_ROUNDS, p, principal());
    expect(result.value).toBe(MCP_ROUNDS.hardCeiling);
    expect(result.hardCeilingApplied).toBe(true);
  });

  it('a ceiling-kind key with no configuration resolves to its hardCeiling, not unlimited', () => {
    const result = resolveLimit(UPLOAD_MB, null, principal());
    expect(result.value).toBe(UPLOAD_MB.hardCeiling);
  });

  it('a ceiling-kind key can still be LOWERED below the hardCeiling', () => {
    const p = policy([{ limitKey: UPLOAD_MB.key, value: 25 }]);
    expect(resolveLimit(UPLOAD_MB, p, principal()).value).toBe(25);
  });
});

describe('resolveLimit — model qualifiers', () => {
  it('an exact model id beats a series within the same layer', () => {
    const p = policy([
      { limitKey: MODEL_REQUESTS.key, series: 'gpt', value: 500 },
      { limitKey: MODEL_REQUESTS.key, modelId: 'gpt-5.2', value: 50 },
    ]);
    expect(resolveLimit(MODEL_REQUESTS, p, principal(), 'gpt-5.2').value).toBe(
      50,
    );
  });

  it('a model-qualified entry does not apply to a different model', () => {
    const p = policy([
      { limitKey: MODEL_REQUESTS.key, modelId: 'gpt-5.2', value: 50 },
    ]);
    expect(
      resolveLimit(MODEL_REQUESTS, p, principal(), 'claude-opus-5').value,
    ).toBeNull();
  });

  it('an unqualified entry applies to every model', () => {
    const p = policy([{ limitKey: MODEL_REQUESTS.key, value: 9 }]);
    expect(resolveLimit(MODEL_REQUESTS, p, principal(), 'anything').value).toBe(
      9,
    );
  });

  it('resolveModelCells produces NO family cell when series is undefined', () => {
    const cells = resolveModelCells(
      MODEL_REQUESTS,
      policy([]),
      principal(),
      'gpt-5.2',
      undefined,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0].modelId).toBe('gpt-5.2');
    expect(cells[0].series).toBeUndefined();
  });

  it('resolveModelCells produces both cells when a series exists', () => {
    const cells = resolveModelCells(
      MODEL_REQUESTS,
      policy([]),
      principal(),
      'gpt-5.2',
      'gpt',
    );
    expect(cells).toHaveLength(2);
    expect(cells.map((c) => c.modelId ?? c.series)).toEqual(['gpt-5.2', 'gpt']);
  });

  it('model.allowed=false blocks a model, and a user override can re-enable it', () => {
    const blocked = policy([
      { limitKey: MODEL_ALLOWED.key, modelId: 'gpt-5.2', value: false },
    ]);
    expect(
      isBlocked(resolveLimit(MODEL_ALLOWED, blocked, principal(), 'gpt-5.2')),
    ).toBe(true);

    const withException = policy(
      [{ limitKey: MODEL_ALLOWED.key, modelId: 'gpt-5.2', value: false }],
      [
        override(
          'user',
          ['ada@example.org'],
          [{ limitKey: MODEL_ALLOWED.key, modelId: 'gpt-5.2', value: true }],
        ),
      ],
    );
    expect(
      isBlocked(
        resolveLimit(MODEL_ALLOWED, withException, principal(), 'gpt-5.2'),
      ),
    ).toBe(false);
  });
});

describe('resolveLimit — matching edge cases', () => {
  it('disabled overrides are excluded entirely', () => {
    const p = policy(
      [{ value: 100 }],
      [
        override('user', ['ada@example.org'], [{ value: 1 }], {
          enabled: false,
        }),
      ],
    );
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(100);
  });

  it('group overrides do not match a principal with no cached group ids', () => {
    const p = policy(
      [{ value: 100 }],
      [
        override(
          'group',
          ['00000000-0000-0000-0000-000000000001'],
          [{ value: 1 }],
        ),
      ],
    );
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(100);
    expect(result.source).toBe('global');
  });

  it('group overrides match once the membership cache supplies the group id', () => {
    const gid = '00000000-0000-0000-0000-000000000001';
    const p = policy(
      [{ value: 100 }],
      [override('group', [gid], [{ value: 1 }])],
    );
    const result = resolveLimit(
      CHAT_MESSAGES,
      p,
      principal({ groupIds: [gid] }),
    );
    expect(result).toMatchObject({ value: 1, source: 'group' });
  });

  it('a principal with no mail falls back to GLOBAL, not unlimited and not most-restrictive', () => {
    const p = policy(
      [{ value: 100 }],
      [
        override('user', ['ada@example.org'], [{ value: 1 }]),
        override('domain', ['example.org'], [{ value: 2 }]),
      ],
    );
    const anonymous = principal({ mail: undefined, domain: undefined });
    const result = resolveLimit(CHAT_MESSAGES, p, anonymous);
    expect(result.value).toBe(100);
    expect(result.source).toBe('global');
  });

  it('a mail-less principal still matches attribute overrides', () => {
    const p = policy(
      [{ value: 100 }],
      [override('attribute', ['department:health'], [{ value: 7 }])],
    );
    const anonymous = principal({ mail: undefined, domain: undefined });
    expect(resolveLimit(CHAT_MESSAGES, p, anonymous).value).toBe(7);
  });

  it('matches targets case-insensitively', () => {
    const p = policy(
      [],
      [override('user', ['ADA@Example.ORG'], [{ value: 3 }])],
    );
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(3);
  });

  it('domain matching is exact — a subdomain does not match the parent', () => {
    const p = policy(
      [{ value: 100 }],
      [override('domain', ['example.org'], [{ value: 1 }])],
    );
    const sub = principal({
      mail: 'ada@mail.example.org',
      domain: 'mail.example.org',
    });
    expect(resolveLimit(CHAT_MESSAGES, p, sub).value).toBe(100);
  });

  it('treats 0 as a hard block, not as unset', () => {
    const p = policy([{ value: 0 }]);
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(0);
    expect(isUnlimited(result)).toBe(false);
  });
});

describe('resolveAllLimits', () => {
  it('resolves every catalog key and defaults almost everything to unlimited', () => {
    const all = resolveAllLimits(null, principal());
    const limited = Object.values(all).filter((r) => !isUnlimited(r));
    // Only the keys that encode behaviour the app ALREADY has today —
    // plus feature.m365.toolCallsPerDay, whose non-null default cannot
    // change existing behaviour because the toolset ships flag-gated dark.
    expect(limited.map((r) => r.limitKey).sort()).toEqual([
      'feature.m365.mail.deepScansPerDay',
      'feature.m365.mail.draftsPerDay',
      'feature.m365.mail.readsPerDay',
      'feature.m365.toolCallsPerDay',
      'feature.mcp.roundsPerRequest',
      'feature.upload.megabytesPerFile',
    ]);
  });
});

describe('resolveLimit — override ceilings (global tier)', () => {
  it('a global-tier domain ceiling clamps a global user override that lacks one', () => {
    const domainCeiling = override(
      'domain',
      ['example.org'],
      [{ value: 100, ceiling: true }],
    );
    const p = policy(
      [],
      [domainCeiling, override('user', ['ada@example.org'], [{ value: 500 }])],
    );
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(100);
    expect(result.ceilingApplied).toBe(true);
    expect(result.ceilingOverrideId).toBe(domainCeiling.id);
    // Provenance still names the record that WON before the clamp.
    expect(result.source).toBe('user');
  });

  it('OCP capped at 100 (ceiling), except alice at 500 (ceiling): most specific ceiling wins', () => {
    const domainCeiling = override(
      'domain',
      ['example.org'],
      [{ value: 100, ceiling: true }],
    );
    const aliceCeiling = override(
      'user',
      ['alice@example.org'],
      [{ value: 500, ceiling: true }],
    );
    const bobPlain = override('user', ['bob@example.org'], [{ value: 900 }]);
    const p = policy([], [domainCeiling, aliceCeiling, bobPlain]);

    const alice = resolveLimit(
      CHAT_MESSAGES,
      p,
      principal({ mail: 'alice@example.org' }),
    );
    expect(alice.value).toBe(500);
    expect(alice.ceilingApplied).toBeUndefined();
    expect(alice.ceilingOverrideId).toBeUndefined();

    const bob = resolveLimit(
      CHAT_MESSAGES,
      p,
      principal({ mail: 'bob@example.org' }),
    );
    expect(bob.value).toBe(100);
    expect(bob.ceilingApplied).toBe(true);
    expect(bob.ceilingOverrideId).toBe(domainCeiling.id);

    const carol = resolveLimit(
      CHAT_MESSAGES,
      p,
      principal({ mail: 'carol@example.org' }),
    );
    expect(carol).toMatchObject({ value: 100, source: 'domain' });
    expect(carol.ceilingApplied).toBeUndefined();
  });

  it('a more specific override ceiling may sit ABOVE a global default ceiling', () => {
    const domainCeiling = override(
      'domain',
      ['example.org'],
      [{ value: 300, ceiling: true }],
    );
    const p = policy(
      [{ value: 100, ceiling: true }],
      [domainCeiling, override('user', ['ada@example.org'], [{ value: 900 }])],
    );
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(300);
    expect(result.ceilingOverrideId).toBe(domainCeiling.id);
  });

  it('falls back to the global default ceiling when the more specific ceiling record does not match', () => {
    const p = policy(
      [{ value: 100, ceiling: true }],
      [
        override(
          'user',
          ['alice@example.org'],
          [{ value: 500, ceiling: true }],
        ),
        override('user', ['bob@example.org'], [{ value: 900 }]),
      ],
    );
    const bob = resolveLimit(
      CHAT_MESSAGES,
      p,
      principal({ mail: 'bob@example.org' }),
    );
    expect(bob.value).toBe(100);
    expect(bob.ceilingApplied).toBe(true);
    // The DEFAULT pinned it — no override id to name.
    expect(bob.ceilingOverrideId).toBeUndefined();
  });

  it('an override ceiling on another limit key does not clamp this key', () => {
    const p = policy(
      [],
      [
        override(
          'domain',
          ['example.org'],
          [
            {
              limitKey: 'feature.tts.charactersPerDay',
              value: 10,
              ceiling: true,
            },
          ],
        ),
        override('user', ['ada@example.org'], [{ value: 500 }]),
      ],
    );
    const result = resolveLimit(CHAT_MESSAGES, p, principal());
    expect(result.value).toBe(500);
    expect(result.ceilingApplied).toBeUndefined();
  });

  it('a ceiling record does not stop a more specific record from going LOWER', () => {
    const p = policy(
      [],
      [
        override('domain', ['example.org'], [{ value: 100, ceiling: true }]),
        override('user', ['ada@example.org'], [{ value: 5 }]),
      ],
    );
    expect(resolveLimit(CHAT_MESSAGES, p, principal()).value).toBe(5);
  });
});

describe('resolveLimit — neutrality for policies without delegations', () => {
  it('mixed-specificity defaults resolve exactly as today: a qualified non-ceiling default shadows an unqualified ceiling default', () => {
    const p = policy(
      [
        { limitKey: MODEL_REQUESTS.key, value: 100, ceiling: true },
        { limitKey: MODEL_REQUESTS.key, series: 'gpt', value: 500 },
      ],
      [
        override(
          'user',
          ['ada@example.org'],
          [{ limitKey: MODEL_REQUESTS.key, value: 5000 }],
        ),
      ],
    );
    // Family cell: the series default wins the global layer and carries no
    // ceiling, so the user override is NOT clamped (pre-delegation behaviour).
    const family = resolveLimit(
      MODEL_REQUESTS,
      p,
      principal(),
      undefined,
      'gpt',
    );
    expect(family.value).toBe(5000);
    expect(family.ceilingApplied).toBeUndefined();
    // A cell the series default does not speak to falls to the unqualified
    // ceiling default, which clamps.
    const other = resolveLimit(MODEL_REQUESTS, p, principal(), 'claude-x');
    expect(other.value).toBe(100);
    expect(other.ceilingApplied).toBe(true);
  });

  it('`delegations: []` resolves byte-for-byte like a policy without the key', () => {
    const overrides = [
      override('domain', ['example.org'], [{ value: 200 }]),
      override('user', ['ada@example.org'], [{ value: 400 }], { priority: 3 }),
      override(
        'attribute',
        ['department:health'],
        [{ limitKey: 'feature.tts.charactersPerDay', value: 9 }],
      ),
    ];
    const defaults = [{ value: 100, ceiling: true }];
    const without = policy(defaults, overrides);
    const withEmpty = policy(defaults, overrides, { delegations: [] });
    expect(resolveAllLimits(withEmpty, principal())).toEqual(
      resolveAllLimits(without, principal()),
    );
  });

  it('every result carries tier "global" when no delegated override exists', () => {
    const p = policy(
      [{ value: 100 }],
      [override('user', ['ada@example.org'], [{ value: 400 }])],
    );
    const all = resolveAllLimits(p, principal());
    expect(Object.values(all).every((r) => r.tier === 'global')).toBe(true);
    expect(resolveLimit(CHAT_MESSAGES, null, principal()).tier).toBe('global');
  });
});
