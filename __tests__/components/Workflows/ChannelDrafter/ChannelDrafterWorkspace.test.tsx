import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';

import { CHANNEL_PROFILES } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import {
  DEFAULT_CHANNEL_SET_ID,
  channelsOfSet,
  defaultVoicesOfSet,
  virtualDefaultSet,
} from '@/lib/utils/shared/drafter/channels/channelSets';

import { Conversation } from '@/types/chat';
import {
  ChannelDrafterWorkflowState,
  ChannelSetSummary,
  ToneRef,
  Version,
} from '@/types/drafter';

import { ChannelDrafterWorkspace } from '@/components/Workflows/ChannelDrafter/ChannelDrafterWorkspace';
import { createInitialWorkflowState } from '@/components/Workflows/initialState';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import {
  EVERY_SPEC,
  useWorkflowRailStore,
} from '@/client/stores/workflowRailStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What useChannelSets answers; mutated per test, re-read on re-render. */
const channelSets = vi.hoisted(() => ({
  current: {
    sets: [] as ChannelSetSummary[],
    suggestedSetId: null as string | null,
    isAuthoritative: false,
    isSettled: false,
    noSets: false,
  },
}));
vi.mock('@/client/hooks/workflows/useChannelSets', () => ({
  useChannelSets: () => channelSets.current,
}));

const guidesState = vi.hoisted(() => ({
  guides: [] as Array<{
    id: string;
    kind: 'tone' | 'style';
    name: string;
    description: string;
    languages: string[];
  }>,
  isLoadingGuides: false,
}));
vi.mock('@/client/hooks/settings/useAvailableGuides', () => ({
  useAvailableGuides: () => guidesState,
}));

const api = vi.hoisted(() => ({
  generateVersions: vi.fn(),
  assessVersions: vi.fn(),
  reviseVersions: vi.fn(),
  sendPost: vi.fn(),
  extractBrief: vi.fn(),
  suggestAltText: vi.fn(),
  translateBrief: vi.fn(),
  getPublishAccess: vi.fn(async () => ({ configured: false, channels: [] })),
}));
vi.mock('@/client/services/workflows/drafter/drafterApi', () => api);

vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({
    filesEnabled: false,
    mailEnabled: false,
    agentsEnabled: false,
    translationEnabled: false,
    transcriptionEnabled: false,
    docSyncEnabled: false,
    meetingsEnabled: false,
    toolsEnabled: false,
    playbooksEnabled: false,
  }),
}));
vi.mock('@/components/Chat/ChatInput/M365FilePickerModal', () => ({
  default: () => null,
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));

const linkedin = CHANNEL_PROFILES.find((p) => p.id === 'linkedin')!;
const x = CHANNEL_PROFILES.find((p) => p.id === 'x')!;

const virtualDefault: ChannelSetSummary = (() => {
  const data = virtualDefaultSet(CHANNEL_PROFILES);
  return {
    id: DEFAULT_CHANNEL_SET_ID,
    name: data.name,
    language: data.language,
    description: data.description,
    isDefault: data.isDefault,
    grant: 'everyone',
    defaults: data.defaults,
    defaultVoices: defaultVoicesOfSet(data),
    channels: channelsOfSet(data, CHANNEL_PROFILES),
  };
})();

const norway: ChannelSetSummary = {
  id: 'msf-no',
  name: 'MSF Norway',
  language: 'Norwegian',
  description: '',
  isDefault: false,
  grant: 'group',
  defaults: { channelIds: ['linkedin'], articleLink: false, guideIds: ['g-s'] },
  defaultVoices: { linkedin: 'guide-warm' },
  channels: [linkedin],
};

const sweden: ChannelSetSummary = {
  id: 'msf-se',
  name: 'MSF Sweden',
  language: 'Swedish',
  description: '',
  isDefault: true,
  grant: 'everyone',
  defaults: { channelIds: ['x'], articleLink: true, guideIds: [] },
  defaultVoices: {},
  channels: [x],
};

const loading = () => ({
  sets: [virtualDefault],
  suggestedSetId: null,
  isAuthoritative: false,
  isSettled: false,
  noSets: false,
});
const failed = () => ({ ...loading(), isSettled: true });
const served = (sets: ChannelSetSummary[], suggestedSetId: string | null) => ({
  sets,
  suggestedSetId,
  isAuthoritative: true,
  isSettled: true,
  noSets: sets.length === 0,
});

function written(specId: string, toneRef?: ToneRef): Version {
  return {
    specId,
    segments: [
      { id: `${specId}-s1`, text: 'Hello from the field.', usedItemIds: [] },
    ],
    briefRev: 0,
    briefDigest: '',
    handEdited: false,
    history: [],
    ...(toneRef ? { toneRef } : {}),
  };
}

/** A brief with one included item, so the Write button is enabled. */
function briefWithItem(): ChannelDrafterWorkflowState['brief'] {
  return {
    rev: 1,
    keyMessage: 'Clinics reopened.',
    items: [
      {
        id: 'i1',
        kind: 'fact',
        text: 'Twelve clinics reopened in March.',
        provenance: [],
        verified: 'user-asserted',
        decision: 'included',
      },
    ],
    links: [],
    language: 'English',
  };
}

function seed(patch: Partial<ChannelDrafterWorkflowState>) {
  const workflowState: ChannelDrafterWorkflowState = {
    ...(createInitialWorkflowState(
      'channel-drafter',
    ) as ChannelDrafterWorkflowState),
    ...patch,
  };
  const conversation = {
    id: 'draft-1',
    name: 'Draft',
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
    prompt: '',
    temperature: 0.5,
    folderId: null,
    conversationType: 'channel-drafter',
    workflowState,
  } as unknown as Conversation;
  useConversationStore.setState({
    conversations: [conversation],
    selectedConversationId: conversation.id,
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

function liveState(): ChannelDrafterWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as ChannelDrafterWorkflowState;
}

function renderWorkspace() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // A fresh element each time: React bails out of re-rendering the same
  // element object, and the tests re-render to let the mocked hooks answer
  // differently.
  const ui = () => (
    <QueryClientProvider client={queryClient}>
      <ChannelDrafterWorkspace conversationId="draft-1" />
    </QueryClientProvider>
  );
  const result = render(ui());
  return { ...result, rerender: () => result.rerender(ui()) };
}

describe('ChannelDrafterWorkspace and its rule set', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guidesState.guides = [];
    guidesState.isLoadingGuides = false;
    useSettingsStore.setState({
      lastChannelIdsBySet: {},
      lastChannelSetId: null,
      tones: [],
      voiceSets: [],
    });
    useWorkflowRailStore.setState({ scopes: {} });
  });

  /**
   * A source added while the sets were still loading used to make the draft
   * "not fresh": it was fixed to the default set with zero channels and the
   * seed skipped. Nothing written yet = still seedable.
   */
  it('seeds a draft that gained a source while the sets loaded', async () => {
    channelSets.current = loading();
    seed({
      sources: [
        {
          id: 'src-1',
          kind: 'note',
          name: 'A note',
          chars: 10,
          addedAt: new Date().toISOString(),
          text: 'Some notes',
        },
      ],
    });
    const { rerender } = renderWorkspace();
    expect(liveState().setId).toBeUndefined();
    expect(liveState().specIds).toEqual([]);

    channelSets.current = served([norway, sweden], 'msf-no');
    act(() => rerender());

    await waitFor(() => expect(liveState().setId).toBe('msf-no'));
    expect(liveState().specIds).toEqual(['linkedin']);
    expect(liveState().guideIds).toEqual(['g-s']);
    expect(useSettingsStore.getState().lastChannelSetId).toBe('msf-no');
  });

  /**
   * A failed list is not the truth: channels are seeded so the session can
   * go on, but no set is written on the draft (nor remembered) until the
   * server's list arrives — and then it is.
   */
  it('after a failed list, seeds channels for the session but fixes the set only once the real list arrives', async () => {
    useSettingsStore.setState({
      lastChannelIdsBySet: { [DEFAULT_CHANNEL_SET_ID]: ['x'] },
    });
    channelSets.current = failed();
    seed({});
    const { rerender } = renderWorkspace();

    await waitFor(() => expect(liveState().specIds).toEqual(['x']));
    expect(liveState().setId).toBeUndefined();
    expect(useSettingsStore.getState().lastChannelSetId).toBeNull();

    channelSets.current = served([norway, sweden], 'msf-se');
    act(() => rerender());

    await waitFor(() => expect(liveState().setId).toBe('msf-se'));
    expect(liveState().specIds).toEqual(['x']);
    expect(useSettingsStore.getState().lastChannelSetId).toBe('msf-se');
  });

  it('pauses a draft whose set is gone, names the lost set and offers to move it', async () => {
    channelSets.current = served([norway], 'msf-no');
    seed({
      setId: 'gone-set',
      specIds: ['linkedin', 'x'],
      versions: { linkedin: written('linkedin'), x: written('x') },
      brief: briefWithItem(),
    });
    renderWorkspace();

    // The banner names the lost set's id (its name is unknown).
    const banner = await screen.findByText('setLost');
    expect(banner).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'check' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'revise' })).toBeDisabled();

    // Writing is off, not sent to the dead set.
    expect(
      screen.getByRole('button', { name: /writeAgain|updateChannels/ }),
    ).toBeDisabled();
    expect(api.generateVersions).not.toHaveBeenCalled();

    // No channel row is remembered under a set the user does not have.
    expect(
      useSettingsStore.getState().lastChannelIdsBySet['gone-set'],
    ).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'moveToSet' }));
    await waitFor(() => expect(liveState().setId).toBe('msf-no'));
    // X is not offered by MSF Norway: it left play, its text kept.
    expect(liveState().specIds).toEqual(['linkedin']);
    expect(liveState().versions.x).toBeDefined();
    expect(screen.getByText('setSwitched')).toBeInTheDocument();
    expect(screen.queryByText('setLost')).toBeNull();
    await waitFor(() =>
      expect(useSettingsStore.getState().lastChannelIdsBySet['msf-no']).toEqual(
        ['linkedin'],
      ),
    );
  });

  it('says so, and seeds nothing, when the user has no set at all', async () => {
    channelSets.current = served([], null);
    seed({ brief: briefWithItem() });
    renderWorkspace();

    expect(await screen.findByText('noSetsAvailable')).toBeInTheDocument();
    expect(liveState().setId).toBeUndefined();
    expect(liveState().specIds).toEqual([]);
    expect(screen.getByRole('button', { name: 'check' })).toBeDisabled();
    expect(useSettingsStore.getState().lastChannelSetId).toBeNull();
  });

  it("applies a set's default voice only when the user can read the guide", async () => {
    guidesState.guides = [
      {
        id: 'guide-warm',
        kind: 'tone',
        name: 'Warm',
        description: '',
        languages: [],
      },
    ];
    channelSets.current = served([norway], 'msf-no');
    seed({});
    const { unmount } = renderWorkspace();
    await waitFor(() =>
      expect(liveState().versions.linkedin?.toneRef).toEqual({
        kind: 'guide',
        id: 'guide-warm',
      }),
    );
    unmount();

    // The same set for a user who cannot read that guide: no voice, rather
    // than one the server refuses on every write.
    guidesState.guides = [];
    seed({});
    renderWorkspace();
    await waitFor(() => expect(liveState().specIds).toEqual(['linkedin']));
    expect(liveState().versions.linkedin?.toneRef).toBeUndefined();
  });

  it('leaves out a voice the user cannot read when writing, and names the failure', async () => {
    channelSets.current = served([norway], 'msf-no');
    seed({
      setId: 'msf-no',
      specIds: ['linkedin'],
      versions: {
        linkedin: written('linkedin', { kind: 'guide', id: 'guide-secret' }),
      },
      brief: briefWithItem(),
    });
    api.generateVersions.mockResolvedValue({
      versions: [
        { specId: 'linkedin', segments: [], error: 'VOICE_UNAVAILABLE' },
      ],
    });
    renderWorkspace();

    fireEvent.click(
      await screen.findByRole('button', { name: /writeAgain|updateChannels/ }),
    );
    await waitFor(() => expect(api.generateVersions).toHaveBeenCalled());
    const request = api.generateVersions.mock.calls[0][0] as {
      setId: string;
      toneGuideIds: Record<string, string>;
    };
    expect(request.setId).toBe('msf-no');
    expect(request.toneGuideIds).toEqual({});

    // The server's code becomes a specific message, not "could not be written".
    expect(await screen.findByText('voiceUnavailable')).toBeInTheDocument();
    // And the voice picker shows the voice as unavailable instead of blank.
    fireEvent.click(screen.getByRole('button', { name: 'voice' }));
    expect(
      screen.getByRole('option', { name: 'voiceUnavailableOption' }),
    ).toBeInTheDocument();
  });

  it('keeps "no voice" on a channel that was removed and put back', async () => {
    guidesState.guides = [
      {
        id: 'guide-warm',
        kind: 'tone',
        name: 'Warm',
        description: '',
        languages: [],
      },
    ];
    channelSets.current = served([norway], 'msf-no');
    // A version written without a voice: the user's choice.
    seed({
      setId: 'msf-no',
      specIds: ['linkedin'],
      versions: { linkedin: written('linkedin') },
    });
    renderWorkspace();
    await screen.findByRole('button', { name: 'addChannels' });

    fireEvent.click(screen.getByRole('button', { name: 'addChannels' }));
    const toggle = screen.getByRole('checkbox', { name: 'LinkedIn' });
    fireEvent.click(toggle);
    expect(liveState().specIds).toEqual([]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'LinkedIn' }));
    expect(liveState().specIds).toEqual(['linkedin']);
    expect(liveState().versions.linkedin.toneRef).toBeUndefined();
  });

  it('drops focus and the rail scope when a set change removes the focused channel', async () => {
    channelSets.current = served([norway, sweden], 'msf-no');
    seed({
      setId: 'msf-no',
      specIds: ['linkedin'],
      versions: { linkedin: written('linkedin') },
    });
    renderWorkspace();

    fireEvent.click(
      await screen.findByRole('button', { name: 'focusChannel' }),
    );
    expect(
      screen.getByRole('button', { name: 'backToCompare' }),
    ).toBeInTheDocument();
    expect(useWorkflowRailStore.getState().scopes['draft-1']).toEqual({
      specIds: ['linkedin'],
    });

    fireEvent.click(screen.getByRole('button', { name: 'setPicker' }));
    // The picker shows the language beside the name and a Default badge.
    expect(screen.getByText('· Swedish')).toBeInTheDocument();
    expect(screen.getByText('setDefaultBadge')).toBeInTheDocument();
    fireEvent.click(screen.getByText('MSF Sweden'));

    await waitFor(() => expect(liveState().setId).toBe('msf-se'));
    expect(liveState().specIds).toEqual([]);
    expect(screen.queryByRole('button', { name: 'backToCompare' })).toBeNull();
    await waitFor(() =>
      expect(useWorkflowRailStore.getState().scopes['draft-1']).toBe(
        EVERY_SPEC,
      ),
    );
  });
});
