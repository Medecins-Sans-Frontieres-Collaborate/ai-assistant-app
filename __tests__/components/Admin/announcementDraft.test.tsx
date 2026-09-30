import { Announcement } from '@/lib/services/announcements/types';
import { announcementWriteSchema } from '@/lib/services/announcements/writePath';

import {
  currentSourceHash,
  draftFromAnnouncement,
  emptyDraft,
  fromLocalInput,
  localeState,
  toLocalInput,
  toWriteBody,
} from '@/components/Admin/Announcements/announcementDraft';

import { describe, expect, it } from 'vitest';

const NONE = { everyone: false, nonDismissible: false };

describe('announcement editor draft', () => {
  it('a fresh draft produces a body the server schema accepts', () => {
    const draft = emptyDraft('fr', '');
    draft.content.fr.title = 'Maintenance';
    const body = toWriteBody(draft, 'draft', NONE);
    expect(announcementWriteSchema.safeParse(body).success).toBe(true);
    expect(body.sourceLocale).toBe('fr');
    expect(body.audience).toEqual({ kind: 'everyone' });
    expect(body).not.toHaveProperty('delegationId');
    expect(body).not.toHaveProperty('action');
  });

  it('round-trips a stored record', () => {
    const stored: Announcement = {
      id: 'ann-000000000001',
      revision: 3,
      status: 'published',
      severity: 'warning',
      dismissible: false,
      audience: {
        kind: 'targeted',
        predicates: [
          { scope: 'domain', targets: ['ocp.msf.org', 'ocb.msf.org'] },
        ],
      },
      delegationId: 'del-0000000000aa',
      visibleFrom: '2026-10-10T00:00:00.000Z',
      expiresAt: '2026-10-12T00:00:00.000Z',
      hideAfterVariable: 'window',
      sourceLocale: 'en',
      content: {
        en: {
          title: 'Down {window}',
          body: 'Sorry.',
          actionLabel: 'Details',
          origin: 'source',
          sourceHash: 'h',
        },
        fr: {
          title: 'Arrêt {window}',
          body: 'Désolé.',
          origin: 'ai',
          sourceHash: 'h',
        },
      },
      variables: [
        {
          name: 'window',
          type: 'timeRange',
          from: '2026-10-12T14:00:00.000Z',
          to: '2026-10-12T18:00:00.000Z',
        },
      ],
      action: { url: 'https://intranet.example.org/x' },
      createdBy: 'a',
      createdAt: 'x',
      updatedBy: 'a',
      updatedAt: 'x',
    };
    const body = toWriteBody(draftFromAnnouncement(stored), 'published', {
      everyone: false,
      nonDismissible: true,
    });
    expect(announcementWriteSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      severity: 'warning',
      dismissible: false,
      delegationId: 'del-0000000000aa',
      hideAfterVariable: 'window',
      audience: stored.audience,
      action: { url: 'https://intranet.example.org/x' },
      confirmNonDismissible: true,
    });
    expect(body.content.fr).toEqual({
      title: 'Arrêt {window}',
      body: 'Désolé.',
      origin: 'ai',
    });
  });

  it('"specific people" with nothing entered falls back to everyone rather than to nobody', () => {
    const draft = emptyDraft('en', '');
    draft.content.en.title = 'T';
    draft.everyone = false;
    draft.predicates = [{ scope: 'domain', text: '  ' }];
    expect(toWriteBody(draft, 'draft', NONE).audience).toEqual({
      kind: 'everyone',
    });
  });

  it('flags a translation as outdated once the source text changes', () => {
    const draft = emptyDraft('en', '');
    draft.content.en.title = 'Maintenance';
    draft.content.fr = {
      title: 'Maintenance FR',
      body: '',
      actionLabel: '',
      origin: 'ai',
      sourceHash: currentSourceHash(draft),
    };
    expect(localeState(draft, 'en')).toBe('source');
    expect(localeState(draft, 'fr')).toBe('ai');
    expect(localeState(draft, 'de')).toBe('missing');

    draft.content.en.title = 'Maintenance tonight';
    expect(localeState(draft, 'fr')).toBe('stale');
  });

  it('converts datetime-local values both ways without drifting', () => {
    const iso = '2026-10-12T14:30:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(fromLocalInput('nonsense')).toBe('');
    expect(toLocalInput('nonsense')).toBe('');
  });
});
