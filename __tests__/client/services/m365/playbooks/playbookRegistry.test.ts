import {
  buildPlaybookContext,
  hasTranscriptFilePreview,
  hasTranscriptMessage,
  isMorningHour,
} from '@/client/services/m365/playbooks/playbookContext';
import {
  M365_PLAYBOOKS,
  getEligiblePlaybooks,
  getPlaybookMeta,
  loadPlaybookPrompt,
} from '@/client/services/m365/playbooks/playbookRegistry';

import type { ConversationEntry, FilePreview } from '@/types/chat';

import { describe, expect, it } from 'vitest';

function userMessage(content: string): ConversationEntry {
  return { role: 'user', content, messageType: 'TEXT' } as ConversationEntry;
}

function assistantGroup(content: string): ConversationEntry {
  return {
    type: 'assistant_group',
    activeIndex: 0,
    versions: [
      { content, messageType: 'TEXT', createdAt: '2026-07-31T00:00:00.000Z' },
    ],
  } as ConversationEntry;
}

function preview(name: string): FilePreview {
  return {
    name,
    type: 'text/plain',
    status: 'completed',
    previewUrl: 'blob:x',
  } as FilePreview;
}

/** Local-clock morning band, injected so the matrix is timezone-stable. */
function at(hour: number): Date {
  return new Date(2026, 6, 31, hour, 30, 0);
}

describe('M365 playbook preconditions', () => {
  const matrix: Array<{
    context: Parameters<typeof getEligiblePlaybooks>[0];
    eligible: string[];
  }> = [
    {
      context: {
        hasTranscriptAttachment: true,
        isMorning: true,
        m365Connected: true,
      },
      eligible: ['meetingFollowThrough', 'morningTriage'],
    },
    {
      context: {
        hasTranscriptAttachment: true,
        isMorning: false,
        m365Connected: true,
      },
      eligible: ['meetingFollowThrough'],
    },
    {
      context: {
        hasTranscriptAttachment: false,
        isMorning: true,
        m365Connected: true,
      },
      eligible: ['morningTriage'],
    },
    {
      context: {
        hasTranscriptAttachment: false,
        isMorning: false,
        m365Connected: true,
      },
      eligible: [],
    },
    // The per-user connect opt-in gates BOTH playbooks — a chain with no
    // Microsoft 365 access has nothing to chain.
    {
      context: {
        hasTranscriptAttachment: true,
        isMorning: true,
        m365Connected: false,
      },
      eligible: [],
    },
  ];

  it.each(matrix)(
    'resolves eligibility for %j',
    ({ context, eligible }: (typeof matrix)[number]) => {
      expect(getEligiblePlaybooks(context).map((p) => p.id)).toEqual(eligible);
    },
  );

  it('exposes the playbooks with i18n keys and kinds', () => {
    expect(M365_PLAYBOOKS.map((p) => p.id)).toEqual([
      'meetingFollowThrough',
      'morningTriage',
      'dailyDigest',
    ]);
    expect(getPlaybookMeta('meetingFollowThrough')?.kind).toBe('prompt');
    // Morning triage opens the digest since the last workday: a Monday
    // covers Friday + the weekend instead of one calendar day.
    expect(getPlaybookMeta('morningTriage')?.kind).toBe('digest');
    expect(getPlaybookMeta('morningTriage')?.digestPreset).toBe('lastWorkday');
    expect(getPlaybookMeta('dailyDigest')?.kind).toBe('digest');
    expect(getPlaybookMeta('morningTriage')?.titleKey).toBe(
      'morningTriage.title',
    );
    expect(getPlaybookMeta('morningTriage')?.descriptionKey).toBe(
      'morningTriage.description',
    );
  });
});

describe('isMorningHour boundaries', () => {
  it.each([
    [4, false],
    [5, true],
    [11, true],
    [12, false],
    [0, false],
    [23, false],
  ])('hour %i → %s', (hour, expected) => {
    expect(isMorningHour(at(hour as number))).toBe(expected);
  });
});

describe('transcript detection', () => {
  it('finds the [Transcript: …] marker on a plain message', () => {
    expect(
      hasTranscriptMessage([userMessage('[Transcript: standup.m4a]\nhello')]),
    ).toBe(true);
  });

  it('finds the marker inside an assistant group version', () => {
    expect(
      hasTranscriptMessage([
        userMessage('imported the meeting'),
        assistantGroup(
          '[Transcript: Weekly sync | blob:abc | expires:2026-08-01T00:00:00Z]',
        ),
      ]),
    ).toBe(true);
  });

  it('ignores a mention of the marker mid-message', () => {
    expect(
      hasTranscriptMessage([userMessage('what does [Transcript: …] mean?')]),
    ).toBe(false);
  });

  it('ignores structured (non-text) content and empty history', () => {
    expect(hasTranscriptMessage([])).toBe(false);
    expect(hasTranscriptMessage(undefined)).toBe(false);
    expect(
      hasTranscriptMessage([
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: '/x.png' } }],
          messageType: 'IMAGE',
        } as unknown as ConversationEntry,
      ]),
    ).toBe(false);
  });

  it('only looks at the recent window', () => {
    const old = [userMessage('[Transcript: old.m4a]')];
    const filler = Array.from({ length: 25 }, (_, i) => userMessage(`m${i}`));
    expect(hasTranscriptMessage([...old, ...filler])).toBe(false);
  });

  it('treats vtt/srt/transcript-named uploads as transcripts', () => {
    expect(hasTranscriptFilePreview([preview('meeting.VTT')])).toBe(true);
    expect(hasTranscriptFilePreview([preview('call.srt')])).toBe(true);
    expect(hasTranscriptFilePreview([preview('Transcript-June.docx')])).toBe(
      true,
    );
    expect(hasTranscriptFilePreview([preview('budget.xlsx')])).toBe(false);
    expect(hasTranscriptFilePreview([])).toBe(false);
  });
});

describe('buildPlaybookContext', () => {
  it('combines message and upload signals with the injected clock', () => {
    expect(
      buildPlaybookContext({
        messages: [userMessage('hi')],
        filePreviews: [preview('sync.vtt')],
        m365Connected: true,
        now: at(9),
      }),
    ).toEqual({
      hasTranscriptAttachment: true,
      isMorning: true,
      m365Connected: true,
    });
  });

  it('defaults to no transcript when nothing is staged', () => {
    expect(buildPlaybookContext({ m365Connected: false, now: at(15) })).toEqual(
      {
        hasTranscriptAttachment: false,
        isMorning: false,
        m365Connected: false,
      },
    );
  });
});

describe('playbook prompt loading', () => {
  it('lazy-loads the meeting follow-through prompt with its staged contract', async () => {
    const prompt = await loadPlaybookPrompt('meetingFollowThrough');

    expect(prompt).toContain('STAGE 1');
    expect(prompt).toContain('STAGE 2');
    expect(prompt).toContain('READ-ONLY');
    // Provenance and the confusion protocol are the two non-negotiables.
    expect(prompt).toContain('drafted from:');
    expect(prompt.toLowerCase()).toContain('ambiguit');
    expect(prompt).toContain('WAIT');
    // The tools the doc's worked example names.
    expect(prompt).toContain('calendar_list_events');
    expect(prompt).toContain('person_resolve');
    expect(prompt).toContain('calendar_get_schedule');
    expect(prompt).toContain('tasks_create');
    expect(prompt).toContain('calendar_create_event');
    // Pausing is designed, not degraded.
    expect(prompt.toLowerCase()).toContain('not a failure');
  });

  it('digest playbooks have no prompt body', async () => {
    // Morning triage and the daily digest open the launcher instead of
    // filling the composer — there is nothing to lazy-load.
    await expect(loadPlaybookPrompt('morningTriage')).resolves.toBeNull();
    await expect(loadPlaybookPrompt('dailyDigest')).resolves.toBeNull();
  });

  it('the prompt playbook never promises to send anything', async () => {
    // Every mail artifact is a DRAFT — a playbook that sends would break the
    // write-confirmation posture the whole design rests on.
    const meeting = await loadPlaybookPrompt('meetingFollowThrough');
    expect(meeting).toContain('mail_create_reply_draft');
    expect(meeting).not.toContain('mail_send');
  });
});
