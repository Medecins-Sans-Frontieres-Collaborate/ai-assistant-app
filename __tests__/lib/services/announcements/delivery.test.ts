import { selectAnnouncementsFor } from '@/lib/services/announcements/delivery';
import {
  Announcement,
  hideAfterInstant,
  isLive,
  sourceHashOf,
  validateLocalizedText,
} from '@/lib/services/announcements/types';
import { SharedDelegation } from '@/lib/services/delegations/types';
import { Principal } from '@/lib/services/shared/principalMatching';

import { describe, expect, it } from 'vitest';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const STAMP = {
  createdBy: 'g@example.com',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedBy: 'g@example.com',
  updatedAt: '2026-10-01T00:00:00.000Z',
};
const DEL = 'del-0000000000aa';

function announcement(extra: Partial<Announcement> = {}): Announcement {
  return {
    id: 'ann-000000000001',
    revision: 1,
    status: 'published',
    severity: 'info',
    dismissible: true,
    audience: { kind: 'everyone' },
    visibleFrom: '2026-10-10T00:00:00.000Z',
    expiresAt: '2026-10-20T00:00:00.000Z',
    sourceLocale: 'en',
    content: {
      en: {
        title: 'Maintenance',
        body: 'Down {window}',
        origin: 'source',
        sourceHash: 'x',
      },
      fr: {
        title: 'Maintenance FR',
        body: 'Arrêt {window}',
        origin: 'ai',
        sourceHash: 'x',
      },
    },
    variables: [],
    ...STAMP,
    ...extra,
  };
}

function delegation(extra: Partial<SharedDelegation> = {}): SharedDelegation {
  return {
    id: DEL,
    label: 'OCP field IT',
    enabled: true,
    jurisdiction: [{ scope: 'domain', targets: ['ocp.msf.org'] }],
    capabilities: ['announcements'],
    admins: [],
    limits: { maxOverrides: 25 },
    ...STAMP,
    ...extra,
  };
}

const ocpUser: Principal = {
  userId: 'oid-1',
  mail: 'a@ocp.msf.org',
  domain: 'ocp.msf.org',
  attributes: ['department:health'],
  groupIds: [],
};
const ocbUser: Principal = {
  userId: 'oid-2',
  mail: 'b@ocb.msf.org',
  domain: 'ocb.msf.org',
  attributes: [],
  groupIds: [],
};

function select(
  announcements: Announcement[],
  principal: Principal,
  options: {
    delegations?: SharedDelegation[];
    locale?: string;
    allowedLinkHosts?: string[];
    now?: number;
  } = {},
) {
  return selectAnnouncementsFor({
    announcements,
    delegations: options.delegations ?? [],
    allowedLinkHosts: options.allowedLinkHosts ?? [],
    principal,
    locale: options.locale ?? 'en',
    now: options.now ?? NOW,
  });
}

describe('window and status', () => {
  it('delivers only published records inside their window', () => {
    expect(select([announcement()], ocpUser)).toHaveLength(1);
    expect(select([announcement({ status: 'draft' })], ocpUser)).toEqual([]);
    expect(select([announcement({ status: 'withdrawn' })], ocpUser)).toEqual(
      [],
    );
    expect(
      select([announcement()], ocpUser, {
        now: Date.parse('2026-10-09T23:59:59Z'),
      }),
    ).toEqual([]);
    // expiresAt is exclusive: at the instant itself it is already gone.
    expect(
      select([announcement()], ocpUser, {
        now: Date.parse('2026-10-20T00:00:00Z'),
      }),
    ).toEqual([]);
  });

  it('retires an announcement once its event is over, before expiresAt', () => {
    const withEvent = announcement({
      hideAfterVariable: 'window',
      variables: [
        {
          name: 'window',
          type: 'timeRange',
          from: '2026-10-12T14:00:00.000Z',
          to: '2026-10-12T18:00:00.000Z',
        },
      ],
    });
    expect(hideAfterInstant(withEvent)).toBe(
      Date.parse('2026-10-12T18:00:00.000Z'),
    );
    expect(isLive(withEvent, NOW)).toBe(true);
    expect(isLive(withEvent, Date.parse('2026-10-12T18:00:00Z'))).toBe(false);
    // The client prunes dismissals by this instant.
    expect(select([withEvent], ocpUser)[0].endsAt).toBe(
      '2026-10-12T18:00:00.000Z',
    );
  });
});

describe('audience', () => {
  it('matches targeted predicates through the shared principal matcher', () => {
    const targeted = announcement({
      audience: {
        kind: 'targeted',
        predicates: [
          { scope: 'attribute', targets: ['department:health'] },
          { scope: 'user', targets: ['someone@else.org'] },
        ],
      },
    });
    expect(select([targeted], ocpUser)).toHaveLength(1);
    expect(select([targeted], ocbUser)).toEqual([]);
  });
});

describe('delegated containment (evaluated at read time)', () => {
  const delegated = announcement({ delegationId: DEL });

  it('reaches only readers inside the delegation’s jurisdiction, even with audience "everyone"', () => {
    const delegations = [delegation()];
    expect(select([delegated], ocpUser, { delegations })).toHaveLength(1);
    expect(select([delegated], ocbUser, { delegations })).toEqual([]);
  });

  it('a targeted audience cannot reach outside the jurisdiction', () => {
    const escaping = announcement({
      delegationId: DEL,
      audience: {
        kind: 'targeted',
        predicates: [{ scope: 'domain', targets: ['ocb.msf.org'] }],
      },
    });
    expect(
      select([escaping], ocbUser, { delegations: [delegation()] }),
    ).toEqual([]);
  });

  it('goes inert when the delegation is disabled, loses the capability, or is gone — never promoted to org-wide', () => {
    for (const delegations of [
      [delegation({ enabled: false })],
      [delegation({ capabilities: ['limits'] })],
      [],
    ]) {
      expect(select([delegated], ocpUser, { delegations })).toEqual([]);
    }
  });

  it('narrowing the jurisdiction takes effect immediately', () => {
    const narrowed = [
      delegation({
        jurisdiction: [{ scope: 'user', targets: ['other@ocp.msf.org'] }],
      }),
    ];
    expect(select([delegated], ocpUser, { delegations: narrowed })).toEqual([]);
  });

  it('always carries the delegation label so it cannot pass as org-wide', () => {
    const [message] = select([delegated], ocpUser, {
      delegations: [delegation()],
    });
    expect(message.from).toBe('OCP field IT');
    expect(select([announcement()], ocpUser)[0].from).toBeUndefined();
  });
});

describe('what leaves the server', () => {
  it('only the reader’s language, falling back to the source language', () => {
    const [french] = select([announcement()], ocpUser, { locale: 'fr' });
    expect(french.title).toBe('Maintenance FR');
    const [fallback] = select([announcement()], ocpUser, { locale: 'de' });
    expect(fallback.title).toBe('Maintenance');
    expect(JSON.stringify(french)).not.toContain('g@example.com');
    expect(french).not.toHaveProperty('audience');
    expect(french).not.toHaveProperty('content');
  });

  it('a link needs a label; a DELEGATED link is re-checked against the allow-list', () => {
    const linked = (extra: Partial<Announcement>) =>
      announcement({
        action: { url: 'https://intranet.example.org/page' },
        content: {
          en: {
            title: 'T',
            body: 'B',
            actionLabel: 'Read more',
            origin: 'source',
            sourceHash: 'x',
          },
        },
        ...extra,
      });
    // Org-wide: global admins may link anywhere.
    expect(select([linked({})], ocpUser)[0].action).toEqual({
      label: 'Read more',
      url: 'https://intranet.example.org/page',
    });
    const delegations = [delegation()];
    expect(
      select([linked({ delegationId: DEL })], ocpUser, { delegations })[0]
        .action,
    ).toBeUndefined();
    expect(
      select([linked({ delegationId: DEL })], ocpUser, {
        delegations,
        allowedLinkHosts: ['intranet.example.org'],
      })[0].action,
    ).toBeDefined();
    // No label → nothing to show (the raw URL never is).
    expect(
      select(
        [announcement({ action: { url: 'https://intranet.example.org' } })],
        ocpUser,
      )[0].action,
    ).toBeUndefined();
  });

  it('orders critical → warning → info, newest first within a severity', () => {
    const messages = select(
      [
        announcement({ id: 'ann-00000000000a', severity: 'info' }),
        announcement({ id: 'ann-00000000000b', severity: 'critical' }),
        announcement({
          id: 'ann-00000000000c',
          severity: 'info',
          visibleFrom: '2026-10-11T00:00:00.000Z',
        }),
        announcement({ id: 'ann-00000000000d', severity: 'warning' }),
      ],
      ocpUser,
    );
    expect(messages.map((m) => m.id)).toEqual([
      'ann-00000000000b',
      'ann-00000000000d',
      'ann-00000000000c',
      'ann-00000000000a',
    ]);
  });
});

describe('validateLocalizedText', () => {
  it('requires declared variables and balanced, un-nested braces', () => {
    expect(validateLocalizedText('Down {window}', ['window'])).toBeNull();
    expect(validateLocalizedText('Down {when}', ['window'])).toMatch(/Unknown/);
    expect(validateLocalizedText('Down {window', ['window'])).toMatch(
      /Unbalanced/,
    );
    expect(validateLocalizedText('Down {{window}}', ['window'])).toMatch(
      /nested/,
    );
  });

  it('a translation must carry exactly the source’s placeholders', () => {
    expect(
      validateLocalizedText(
        'Arrêt {window}',
        ['window', 'day'],
        'Down {window}',
      ),
    ).toBeNull();
    expect(validateLocalizedText('Arrêt', ['window'], 'Down {window}')).toMatch(
      /Missing/,
    );
    expect(
      validateLocalizedText(
        'Arrêt {window} {day}',
        ['window', 'day'],
        'Down {window}',
      ),
    ).toMatch(/Unexpected/);
  });
});

describe('sourceHashOf', () => {
  it('changes with the text and only with the text', () => {
    const a = sourceHashOf({ title: 'T', body: 'B' });
    expect(sourceHashOf({ title: 'T', body: 'B' })).toBe(a);
    expect(sourceHashOf({ title: 'T', body: 'B2' })).not.toBe(a);
    expect(sourceHashOf({ title: 'T', body: 'B', actionLabel: 'L' })).not.toBe(
      a,
    );
  });
});
