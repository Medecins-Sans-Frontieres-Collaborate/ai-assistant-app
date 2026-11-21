import { fireEvent, render, screen, within } from '@testing-library/react';
import { ReactElement } from 'react';

import { NextIntlClientProvider } from 'next-intl';

import {
  delegation,
  override,
  policy,
} from '../../lib/services/limits/policyFixtures';
import { diffPolicies } from '@/lib/services/limits/policyChanges';
import type { UsageInsights } from '@/lib/services/limits/wire';

import { ChangeReview } from '@/components/Limits/ChangeReview';
import { LimitsOverview } from '@/components/Limits/LimitsOverview';
import { PersonLens } from '@/components/Limits/PersonLens';
import { ValueChoice } from '@/components/Limits/ValueChoice';
import { LimitsDraft, draftPolicy } from '@/components/Limits/limitsDraft';

import { getLimitDefinition } from '@/config/limits';
import messages from '@/messages/en.json';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The limits admin screens with the REAL English messages (missing keys and
 * bad ICU throw), so the sentences an admin reads are what is asserted.
 */

vi.unmock('next-intl');

const preview = vi.hoisted(() => ({
  result: null as unknown,
}));

vi.mock('@/client/hooks/settings/useLimitsAdmin', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/client/hooks/settings/useLimitsAdmin')
  >()),
  useEffectiveLimitsPreview: () => ({
    result: preview.result,
    forbidden: false,
    isLoading: false,
    error: null,
  }),
}));
vi.mock('@/client/hooks/useM365PeopleSuggest', () => ({
  useM365PeopleSuggest: () => undefined,
}));

function renderWithMessages(ui: ReactElement) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      onError={(error) => {
        throw error;
      }}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

const MESSAGES = getLimitDefinition('chat.messagesPerDay')!;
const WEB_SEARCH = getLimitDefinition('feature.webSearch.enabled')!;

describe('ValueChoice', () => {
  it('offers four kinds for a counter and keeps the value in its own column', () => {
    const onChange = vi.fn();
    renderWithMessages(
      <ValueChoice
        def={MESSAGES}
        label="Messages per day"
        value={undefined}
        inherited={200}
        onChange={onChange}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Messages per day' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Inherit', 'Limit', 'Unlimited', 'Off']);
    // Inherit shows what comes from below, outside the radio group.
    expect(screen.getByText('from below')).toBeInTheDocument();

    fireEvent.click(within(group).getByLabelText('Limit'));
    // Switching to Limit starts from the inherited number, never unlimited.
    expect(onChange).toHaveBeenLastCalledWith(200);
    fireEvent.click(within(group).getByLabelText('Unlimited'));
    expect(onChange).toHaveBeenLastCalledWith(null);
    fireEvent.click(within(group).getByLabelText('Off'));
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('lets the number be cleared and retyped, committing only valid numbers', () => {
    const onChange = vi.fn();
    renderWithMessages(
      <ValueChoice
        def={MESSAGES}
        label="Messages per day"
        value={500}
        inherited={200}
        onChange={onChange}
      />,
    );
    const field = screen.getByRole('spinbutton');
    expect(screen.getByText('requests a day')).toBeInTheDocument();
    fireEvent.change(field, { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: '350' } });
    expect(onChange).toHaveBeenLastCalledWith(350);
  });

  it('offers On and Off for a switch', () => {
    renderWithMessages(
      <ValueChoice
        def={WEB_SEARCH}
        label="Web search"
        value={true}
        inherited={true}
        onChange={vi.fn()}
      />,
    );
    expect(
      within(screen.getByRole('radiogroup'))
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Inherit', 'On', 'Off']);
  });
});

function draftOf(subject: ReturnType<typeof policy>): LimitsDraft {
  return {
    defaults: subject.defaults,
    modelAccess: subject.modelAccess,
    overrides: subject.overrides,
    delegations: subject.delegations,
    mode: subject.mode,
    failMode: subject.failMode,
    timezone: subject.timezone,
    countByomUsage: subject.countByomUsage,
    countAuxiliaryUsage: subject.countAuxiliaryUsage,
  };
}

function insights(cells: UsageInsights['cells']): UsageInsights {
  return {
    status: 'ready',
    latestDay: '2026-07-23',
    days: ['2026-07-23'],
    partial: false,
    cells,
  };
}

describe('LimitsOverview', () => {
  const del = delegation('del-0000000000c1', [
    { scope: 'domain', targets: ['ocp.org'] },
  ]);
  const held = override('group', ['g-1'], [{ value: 5000 }], {
    label: 'Pharmacy',
  });
  const scoped = override('domain', ['ocp.org'], [{ value: 300 }], {
    delegationId: del.id,
  });
  const saved = policy([{ value: 200, ceiling: true }], [held, scoped], {
    delegations: [del],
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderOverview(onDefaultsChange = vi.fn()) {
    const draft = draftOf(saved);
    renderWithMessages(
      <LimitsOverview
        draft={draft}
        policy={draftPolicy(draft, saved)}
        insights={insights({
          'chat.messagesPerDay': {
            limitKey: 'chat.messagesPerDay',
            yesterday: {
              people: 5,
              bands: { underHalf: 2, toEighty: 1, nearCap: 0, atCap: 2 },
              withoutCap: 0,
            },
            byRule: { global: { people: 4, atCap: 2 } },
            events: 3,
            eventPeople: 2,
            blocked: 0,
            peaks: [10, 50, 120, 200, 200],
            peaksTruncated: false,
          },
        })}
        groupNames={{}}
        onDefaultsChange={onDefaultsChange}
        onEditRule={vi.fn()}
        onAddRule={vi.fn()}
        disabled={false}
      />,
    );
  }

  it('shows exceptions by audience, delegated ones apart, and yesterday’s pressure', () => {
    renderOverview();
    const row = screen.getByRole('button', { name: /^Messages per day/ });
    expect(within(row).getByText('1 rule for Entra group')).toBeInTheDocument();
    expect(
      within(row).getByText(
        '1 rule for Email domain, set by a delegated admin',
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText('2 people hit their cap')).toBeInTheDocument();
    expect(
      within(row).getByRole('img', {
        name: /2 under half of their cap.*2 hit the cap/,
      }),
    ).toBeInTheDocument();
  });

  it('opens a row to edit Everyone and to explain each rule', () => {
    const onDefaultsChange = vi.fn();
    renderOverview(onDefaultsChange);
    fireEvent.click(screen.getByRole('button', { name: /^Messages per day/ }));

    // The group rule asks for more than the hard ceiling allows.
    const pharmacy = screen.getByText('Pharmacy').closest('li') as HTMLElement;
    expect(within(pharmacy).getByText('No effect as set.')).toBeInTheDocument();
    expect(
      within(pharmacy).getByText(/A hard ceiling holds members at 200/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Last week 4 people had their cap from this rule; 2 hit it.',
      ),
    ).toBeInTheDocument();

    const everyone = screen.getByRole('radiogroup', {
      name: 'Messages per day for everyone',
    });
    fireEvent.click(within(everyone).getByLabelText('Unlimited'));
    expect(onDefaultsChange).toHaveBeenCalledWith([
      { limitKey: 'chat.messagesPerDay', value: null, ceiling: true },
    ]);
  });
});

describe('ChangeReview', () => {
  it('states a stricter cap with how many people went over it, and undoes it', () => {
    const saved = policy([{ value: 100 }]);
    const draft = policy([{ value: 50 }]);
    const changes = diffPolicies(saved, draft);
    const onUndo = vi.fn();
    renderWithMessages(
      <ChangeReview
        changes={changes}
        saved={saved}
        draft={draft}
        insights={insights({
          'chat.messagesPerDay': {
            limitKey: 'chat.messagesPerDay',
            yesterday: {
              people: 4,
              bands: { underHalf: 4, toEighty: 0, nearCap: 0, atCap: 0 },
              withoutCap: 0,
            },
            byRule: { global: { people: 4, atCap: 1 } },
            events: 0,
            eventPeople: 0,
            blocked: 0,
            peaks: [10, 60, 90, 100],
            peaksTruncated: false,
          },
        })}
        groupNames={{}}
        onUndo={onUndo}
        onEditRule={vi.fn()}
        onCheckPerson={vi.fn()}
      />,
    );
    expect(screen.getByText('Review 1 change')).toBeInTheDocument();
    expect(
      screen.getByText('Everyone without an exception gets 50 instead of 100.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('3 people had a day above 50 last week.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledWith(changes[0]);
  });

  it('flags a removed cap', () => {
    const saved = policy([{ value: 100 }]);
    const group = override('group', ['g-1'], [{ value: null }]);
    const draft = policy([{ value: 100 }], [group]);
    renderWithMessages(
      <ChangeReview
        changes={diffPolicies(saved, draft)}
        saved={saved}
        draft={draft}
        insights={undefined}
        groupNames={{}}
        onUndo={vi.fn()}
        onEditRule={vi.fn()}
        onCheckPerson={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Removes the cap: no limit applies to these people.'),
    ).toBeInTheDocument();
  });
});

describe('ChangeReview, a rule nobody is in yet', () => {
  it('says it covers nobody instead of describing members', () => {
    const saved = policy([{ value: 150 }]);
    const empty = override('group', [], [{ value: 100 }]);
    const draft = policy([{ value: 150 }], [empty]);
    renderWithMessages(
      <ChangeReview
        changes={diffPolicies(saved, draft)}
        saved={saved}
        draft={draft}
        insights={undefined}
        groupNames={{}}
        onUndo={vi.fn()}
        onEditRule={vi.fn()}
        onCheckPerson={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        'Covers nobody yet, so it changes nothing until people are added.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Members get/)).not.toBeInTheDocument();
  });
});

describe('PersonLens', () => {
  it('resolves the person against the draft and rings the deciding level', () => {
    const group = override('group', ['g-1'], [{ value: 500 }], {
      label: 'Field coordinators',
    });
    const saved = policy([{ value: 200 }], [group]);
    const draft = policy(
      [{ value: 200 }],
      [{ ...group, entries: [{ ...group.entries[0], value: 800 }] }],
    );
    preview.result = {
      enabled: true,
      preview: true,
      subject: 'a.person@ocp.org',
      directoryStatus: 'resolved',
      limits: [
        {
          limitKey: 'chat.messagesPerDay',
          value: 500,
          unit: 'requests',
          window: 'day',
          source: 'group',
          used: 340,
        },
      ],
      principal: {
        mail: 'a.person@ocp.org',
        domain: 'ocp.org',
        attributes: [],
        groupIds: ['g-1'],
      },
    };
    renderWithMessages(
      <PersonLens
        saved={saved}
        draft={draft}
        dirty
        groupNames={{}}
        onEditRule={vi.fn()}
        initialMail="a.person@ocp.org"
      />,
    );
    const row = screen
      .getByRole('button', { name: 'Messages per day' })
      .closest('tr') as HTMLElement;
    // With the draft: the group rule's new 800 decides, Everyone's 200 lost.
    expect(within(row).getByTitle('800, decides')).toBeInTheDocument();
    expect(within(row).getByTitle('200, outranked')).toBeInTheDocument();
    expect(within(row).getByText('340 of 800')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Saved'));
    const savedRow = screen
      .getByRole('button', { name: 'Messages per day' })
      .closest('tr') as HTMLElement;
    expect(within(savedRow).getByTitle('500, decides')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('With your changes'));
    fireEvent.click(screen.getByRole('button', { name: 'Messages per day' }));
    expect(
      screen.getByText(/decided by Field coordinators/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('With your changes; saved policy: 500.'),
    ).toBeInTheDocument();
  });
});
