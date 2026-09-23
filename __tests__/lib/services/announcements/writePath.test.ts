import {
  translateAnnouncement,
  validateTranslatedContent,
} from '@/lib/services/announcements/translate';
import {
  AnnouncementsDocument,
  sourceHashOf,
} from '@/lib/services/announcements/types';
import {
  AnnouncementWrite,
  announcementWriteSchema,
  mayAuthorUnder,
  toStoredAnnouncement,
  validateAnnouncementWrite,
} from '@/lib/services/announcements/writePath';
import { DelegatedAdminStatus } from '@/lib/services/delegations/delegationsAdminAuth';

import { describe, expect, it, vi } from 'vitest';

const DEL = 'del-0000000000aa';
const GLOBAL: DelegatedAdminStatus = {
  isGlobalAdmin: true,
  isDelegatedAdmin: false,
  delegationIds: [],
};
const DELEGATED: DelegatedAdminStatus = {
  isGlobalAdmin: false,
  isDelegatedAdmin: true,
  delegationIds: [DEL],
};

const emptyDocument: AnnouncementsDocument = {
  version: 1,
  announcements: [],
  allowedLinkHosts: ['intranet.example.org'],
  updatedBy: '',
  updatedAt: '',
};

function body(extra: Record<string, unknown> = {}): AnnouncementWrite {
  return announcementWriteSchema.parse({
    status: 'draft',
    audience: { kind: 'everyone' },
    visibleFrom: '2026-10-10T00:00:00.000Z',
    expiresAt: '2026-10-12T00:00:00.000Z',
    sourceLocale: 'en',
    content: { en: { title: 'Maintenance', body: 'Down.', origin: 'source' } },
    ...extra,
  });
}

const check = (
  input: AnnouncementWrite,
  status = GLOBAL,
  document = emptyDocument,
) => validateAnnouncementWrite(input, { status, document });

describe('authority', () => {
  it('a delegated sender may author only under their own delegations — one uniform answer otherwise', () => {
    expect(mayAuthorUnder(GLOBAL, undefined)).toBe(true);
    expect(mayAuthorUnder(DELEGATED, DEL)).toBe(true);
    expect(mayAuthorUnder(DELEGATED, undefined)).toBe(false);
    expect(mayAuthorUnder(DELEGATED, 'del-0000000000bb')).toBe(false);
  });

  it('critical severity is for global admins', () => {
    expect(
      check(body({ severity: 'critical', delegationId: DEL }), DELEGATED)?.code,
    ).toBe('ANNOUNCEMENT_FORBIDDEN_SEVERITY');
    expect(check(body({ severity: 'critical' }))).toBeNull();
  });
});

describe('publishing needs explicit acknowledgements', () => {
  it('to EVERYONE, org-wide', () => {
    expect(check(body({ status: 'published' }))?.code).toBe(
      'ANNOUNCEMENT_CONFIRM_EVERYONE',
    );
    expect(
      check(body({ status: 'published', confirmEveryone: true })),
    ).toBeNull();
    // A delegation's "everyone" is its own jurisdiction: no org-wide warning.
    expect(
      check(body({ status: 'published', delegationId: DEL }), DELEGATED),
    ).toBeNull();
  });

  it('non-dismissible: available to delegated senders too, never without the second confirmation, capped at 72 h', () => {
    const nonDismissible = {
      status: 'published',
      dismissible: false,
      delegationId: DEL,
    };
    expect(check(body(nonDismissible), DELEGATED)?.code).toBe(
      'ANNOUNCEMENT_CONFIRM_NON_DISMISSIBLE',
    );
    expect(
      check(
        body({ ...nonDismissible, confirmNonDismissible: true }),
        DELEGATED,
      ),
    ).toBeNull();
    expect(
      check(
        body({
          ...nonDismissible,
          confirmNonDismissible: true,
          expiresAt: '2026-10-14T00:00:00.000Z',
        }),
        DELEGATED,
      )?.code,
    ).toBe('ANNOUNCEMENT_WINDOW');
    // A draft is not a publication.
    expect(check(body({ dismissible: false }))).toBeNull();
  });
});

describe('window', () => {
  it('must end after it starts and is bounded (30 days global, 14 delegated)', () => {
    expect(check(body({ expiresAt: '2026-10-09T00:00:00.000Z' }))?.code).toBe(
      'ANNOUNCEMENT_WINDOW',
    );
    const twentyDays = { expiresAt: '2026-10-30T00:00:00.000Z' };
    expect(check(body(twentyDays))).toBeNull();
    expect(
      check(body({ ...twentyDays, delegationId: DEL }), DELEGATED)?.code,
    ).toBe('ANNOUNCEMENT_WINDOW');
    expect(check(body({ expiresAt: '2026-11-20T00:00:00.000Z' }))?.code).toBe(
      'ANNOUNCEMENT_WINDOW',
    );
  });
});

describe('links', () => {
  const linked = (url: string, extra: Record<string, unknown> = {}) =>
    body({
      action: { url },
      content: {
        en: {
          title: 'T',
          body: 'B',
          actionLabel: 'Read more',
          origin: 'source',
        },
      },
      ...extra,
    });

  it('https only, no credentials, and a label is required', () => {
    expect(check(linked('http://example.org'))?.code).toBe('ANNOUNCEMENT_LINK');
    expect(check(linked('javascript:alert(1)'))?.code).toBe(
      'ANNOUNCEMENT_LINK',
    );
    expect(check(linked('https://user:pw@example.org'))?.code).toBe(
      'ANNOUNCEMENT_LINK',
    );
    expect(check(body({ action: { url: 'https://example.org' } }))?.code).toBe(
      'ANNOUNCEMENT_LINK',
    );
    expect(check(linked('https://anywhere.example.com'))).toBeNull();
  });

  it('a delegated sender can SAVE a draft to an unapproved host but not PUBLISH it', () => {
    const draft = linked('https://new-host.example.com/x', {
      delegationId: DEL,
    });
    expect(check(draft, DELEGATED)).toBeNull();
    const publishing = linked('https://new-host.example.com/x', {
      delegationId: DEL,
      status: 'published',
    });
    const problem = check(publishing, DELEGATED);
    expect(problem?.code).toBe('ANNOUNCEMENT_HOST_NOT_ALLOWED');
    expect(problem?.details).toBe('new-host.example.com');
    expect(
      check(
        linked('https://intranet.example.org/x', {
          delegationId: DEL,
          status: 'published',
        }),
        DELEGATED,
      ),
    ).toBeNull();
  });
});

describe('content', () => {
  it('source text obeys the LOWER source caps; translations the stored caps', () => {
    expect(
      check(
        body({
          content: {
            en: { title: 'x'.repeat(71), body: '', origin: 'source' },
          },
        }),
      )?.code,
    ).toBe('ANNOUNCEMENT_TOO_LONG');
    expect(
      check(
        body({
          content: {
            en: { title: 'Short', body: '', origin: 'source' },
            de: { title: 'x'.repeat(85), body: '', origin: 'ai' },
          },
        }),
      ),
    ).toBeNull();
  });

  it('refuses undeclared variables, translations that lose one, and a bad hideAfterVariable', () => {
    const variables = [
      {
        name: 'window',
        type: 'timeRange',
        from: '2026-10-12T14:00:00.000Z',
        to: '2026-10-12T18:00:00.000Z',
      },
    ];
    expect(
      check(
        body({
          content: { en: { title: 'T {when}', body: '', origin: 'source' } },
        }),
      )?.code,
    ).toBe('ANNOUNCEMENT_PLACEHOLDERS');
    expect(
      check(
        body({
          variables,
          content: {
            en: { title: 'Down {window}', body: '', origin: 'source' },
            fr: { title: 'Arrêt', body: '', origin: 'ai' },
          },
        }),
      )?.details,
    ).toMatch(/^fr\.title/);
    expect(check(body({ variables, hideAfterVariable: 'nope' }))?.code).toBe(
      'ANNOUNCEMENT_INVALID',
    );
    expect(check(body({ variables, hideAfterVariable: 'window' }))).toBeNull();
  });
});

describe('caps', () => {
  it('limits concurrently published announcements per tier', () => {
    const published = (id: string, delegationId?: string) => ({
      id,
      revision: 1,
      status: 'published' as const,
      severity: 'info' as const,
      dismissible: true,
      audience: { kind: 'everyone' as const },
      ...(delegationId ? { delegationId } : {}),
      visibleFrom: '2026-01-01T00:00:00.000Z',
      expiresAt: '2999-01-01T00:00:00.000Z',
      sourceLocale: 'en',
      content: {},
      variables: [],
      createdBy: 'x',
      createdAt: 'x',
      updatedBy: 'x',
      updatedAt: 'x',
    });
    const document = {
      ...emptyDocument,
      announcements: [1, 2, 3].map((n) =>
        published(`ann-00000000000${n}`, DEL),
      ),
    };
    expect(
      check(
        body({ status: 'published', delegationId: DEL }),
        DELEGATED,
        document,
      )?.code,
    ).toBe('ANNOUNCEMENT_CAP');
    // The global tier has its own, separate budget.
    expect(
      check(
        body({ status: 'published', confirmEveryone: true }),
        GLOBAL,
        document,
      ),
    ).toBeNull();
  });
});

describe('toStoredAnnouncement', () => {
  it('bumps the revision only on "notify again", and never moves a record between tiers', () => {
    const first = toStoredAnnouncement(
      body({ delegationId: DEL }),
      'ann-000000000001',
      undefined,
      'a@x.org',
      'now',
    );
    expect(first.revision).toBe(1);
    expect(first.delegationId).toBe(DEL);

    const edited = toStoredAnnouncement(
      body({ delegationId: undefined }),
      first.id,
      first,
      'b@x.org',
      'later',
    );
    expect(edited.revision).toBe(1);
    expect(edited.delegationId).toBe(DEL);
    expect(edited.createdBy).toBe('a@x.org');

    const again = toStoredAnnouncement(
      body({ notifyAgain: true }),
      first.id,
      edited,
      'b@x.org',
      'later',
    );
    expect(again.revision).toBe(2);
  });

  it('an untouched translation keeps the hash it was made FROM, so a source edit shows it as stale', () => {
    const v1 = toStoredAnnouncement(
      body({
        content: {
          en: { title: 'Maintenance', body: '', origin: 'source' },
          fr: { title: 'Maintenance FR', body: '', origin: 'ai' },
        },
      }),
      'ann-000000000001',
      undefined,
      'a@x.org',
      'now',
    );
    const v2 = toStoredAnnouncement(
      body({
        content: {
          en: { title: 'Maintenance tonight', body: '', origin: 'source' },
          fr: { title: 'Maintenance FR', body: '', origin: 'ai' },
        },
      }),
      v1.id,
      v1,
      'a@x.org',
      'later',
    );
    expect(v2.content.en.sourceHash).toBe(
      sourceHashOf({ title: 'Maintenance tonight', body: '' }),
    );
    expect(v2.content.fr.sourceHash).toBe(v1.content.fr.sourceHash);
    expect(v2.content.fr.sourceHash).not.toBe(v2.content.en.sourceHash);
  });
});

describe('AI localization', () => {
  const source = { title: 'Down {window}', body: 'Sorry.' };

  it('validates placeholders and stored length caps', () => {
    expect(
      validateTranslatedContent(
        { title: 'Arrêt {window}', body: 'Désolé.' },
        source,
        ['window'],
      ),
    ).toBeNull();
    expect(
      validateTranslatedContent({ title: 'Arrêt', body: 'Désolé.' }, source, [
        'window',
      ]),
    ).toMatch(/Missing variable/);
    expect(
      validateTranslatedContent(
        { title: 'Arrêt {window}', body: 'x'.repeat(400) },
        source,
        ['window'],
      ),
    ).toMatch(/too long/);
    expect(
      validateTranslatedContent({ title: 'Arrêt {window}', body: '' }, source, [
        'window',
      ]),
    ).toMatch(/body is empty/);
  });

  it('retries once with the complaint, and leaves a locale MISSING rather than storing a broken text', async () => {
    const reply = (title: string) => ({
      choices: [
        {
          message: {
            content: JSON.stringify({ title, body: 'ok', actionLabel: '' }),
          },
        },
      ],
    });
    const create = vi
      .fn()
      // fr: broken, then fixed on the retry.
      .mockResolvedValueOnce(reply('Arrêt'))
      .mockResolvedValueOnce(reply('Arrêt {window}'))
      // de: broken twice.
      .mockResolvedValueOnce(reply('Ausfall'))
      .mockResolvedValueOnce(reply('Ausfall'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = await translateAnnouncement(
      { chat: { completions: { create } } } as never,
      {
        source,
        sourceLocale: 'en',
        targetLocales: ['en', 'fr'],
        variableNames: ['window'],
      },
    );
    expect(outcome.translations.fr.title).toBe('Arrêt {window}');
    expect(create.mock.calls[1][0].messages.at(-1).content).toMatch(
      /rejected: title: Missing variable/,
    );
    // The source language is never a target.
    expect(outcome.translations.en).toBeUndefined();

    const second = await translateAnnouncement(
      { chat: { completions: { create } } } as never,
      {
        source,
        sourceLocale: 'en',
        targetLocales: ['de'],
        variableNames: ['window'],
      },
    );
    expect(second.translations.de).toBeUndefined();
    expect(second.failures.de).toMatch(/Missing variable/);
  });
});
