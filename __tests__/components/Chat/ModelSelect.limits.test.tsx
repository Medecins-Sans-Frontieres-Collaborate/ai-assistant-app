import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import type { ModelAvailability } from '@/client/hooks/settings/useMyLimits';

import { Conversation } from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { ModelSelect } from '@/components/Chat/ModelSelect';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Usage-limit rendering in the model picker
 * (docs/LIMITS_USER_FACING_UX.md §7.4, WP-C).
 *
 * Copy assertions anchor on the echoed message KEYS: the global next-intl
 * mock returns the key when its fixture lacks it, and the `limitsUx.picker`
 * strings live only in messages/en.json.
 */

const mockUseConversations = {
  selectedConversation: null as Conversation | null,
  updateConversation: vi.fn(),
  conversations: [] as Conversation[],
};

const mockUseSettings = {
  models: Object.values(OpenAIModels).filter((m) => !m.isDisabled),
  defaultModelId: OpenAIModelID.GPT_5_2,
  setDefaultModelId: vi.fn(),
};

const mockFlags: Record<string, unknown> = {};

const mockFoundryAgents = {
  foundryAgents: [] as Array<Record<string, unknown>>,
  suppressedOrgAgentIds: [] as string[],
  regionalPath: null as string | null,
  officePaths: [] as string[],
  isLoadingFoundryAgents: false,
  foundryAgentsError: null,
  refetchFoundryAgents: vi.fn(),
  retryFoundryAgents: vi.fn(),
};

vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));
vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => mockUseConversations,
}));
vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => mockUseSettings,
}));
vi.mock('@/client/hooks/settings/useFoundryAgents', () => ({
  useFoundryAgents: () => mockFoundryAgents,
}));

// WP-B's hook, stubbed with a mutable verdict map. `useResetCountdown` and
// friends stay real (importOriginal) — they carry no React Query.
const limitsState = vi.hoisted(() => ({
  enforce: true,
  models: {} as Record<string, ModelAvailability>,
  refetch: vi.fn(),
}));
vi.mock('@/client/hooks/settings/useMyLimits', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/client/hooks/settings/useMyLimits')
    >();
  return {
    ...actual,
    useLimitsEnabled: () => limitsState.enforce,
    useMyLimits: () => ({
      limits: [],
      mode: limitsState.enforce ? ('enforce' as const) : ('observe' as const),
      enforce: limitsState.enforce,
      isLimited: Object.keys(limitsState.models).length > 0,
      models: limitsState.models,
      usageUnavailable: false,
      policyUnavailable: false,
      isLoading: false,
      error: null,
      refetch: limitsState.refetch,
    }),
  };
});

const IN_SIX_HOURS = () => new Date(Date.now() + 6 * 3600_000).toISOString();

const exhausted = (
  overrides: Partial<ModelAvailability> = {},
): ModelAvailability => ({
  allowed: true,
  reason: 'exhausted',
  limit: 20,
  used: 20,
  remaining: 0,
  resetAt: IN_SIX_HOURS(),
  ...overrides,
});

const conversationOn = (id: OpenAIModelID): Conversation => ({
  id: 'conv-1',
  name: 'Test',
  messages: [],
  model: OpenAIModels[id],
  prompt: '',
  temperature: 0.7,
  folderId: null,
});

/** The list row (ModelCard) whose visible name is `label`. */
const rowNamed = (label: string) =>
  screen.getByText(label).closest('button') as HTMLButtonElement;

describe('ModelSelect — usage-limit states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockFlags)) delete mockFlags[key];
    limitsState.enforce = true;
    limitsState.models = {};
    useSettingsStore.setState({
      customAgentSources: [],
      customModelSources: [],
      starredModelIds: [],
      hiddenModelIds: [],
      modelUsageStats: {},
      userRegion: null,
    });
    mockUseConversations.selectedConversation = conversationOn(
      OpenAIModelID.GPT_5_2,
    );
  });

  describe('fail-open', () => {
    it("renders today's picker when the policy is not enforced, even with exhausted entries", () => {
      limitsState.enforce = false;
      limitsState.models = { [OpenAIModelID.DEEPSEEK_V3_1]: exhausted() };
      render(<ModelSelect />);

      expect(screen.queryByTestId('model-limit-badge')).toBeNull();
      expect(screen.queryByTestId('model-limit-remaining')).toBeNull();
      const row = rowNamed('DeepSeek');
      expect(row).not.toHaveAttribute('aria-disabled');
      fireEvent.click(row);
      expect(mockUseConversations.updateConversation).toHaveBeenCalled();
    });

    it('treats an entry with a cap but no reason as available (usage unreadable)', () => {
      limitsState.models = {
        [OpenAIModelID.DEEPSEEK_V3_1]: { allowed: true, limit: 20 },
      };
      render(<ModelSelect />);
      expect(screen.queryByTestId('model-limit-badge')).toBeNull();
      expect(rowNamed('DeepSeek')).not.toHaveAttribute('aria-disabled');
    });
  });

  describe('exhausted rows', () => {
    it('dims the row, marks it aria-disabled and shows the clock badge with counts + countdown', () => {
      // The conversation sits on DeepSeek so the family row fronts it
      // (selection wins) and the exhausted state is on the visible row.
      mockUseConversations.selectedConversation = conversationOn(
        OpenAIModelID.DEEPSEEK_V3_1,
      );
      limitsState.models = { [OpenAIModelID.DEEPSEEK_V3_1]: exhausted() };
      render(<ModelSelect />);

      const row = rowNamed('DeepSeek');
      expect(row).toHaveAttribute('aria-disabled', 'true');
      expect(row.closest('.opacity-60')).not.toBeNull();
      const badge = within(row).getByTestId('model-limit-badge');
      // A future resetAt → the countdown variant of the sentence.
      expect(badge).toHaveAttribute('aria-label', 'exhausted');
      expect(badge).toHaveAttribute('title', 'exhausted');
    });

    it('uses the no-reset wording when the server sent no resetAt', () => {
      mockUseConversations.selectedConversation = conversationOn(
        OpenAIModelID.DEEPSEEK_V3_1,
      );
      limitsState.models = {
        [OpenAIModelID.DEEPSEEK_V3_1]: exhausted({ resetAt: undefined }),
      };
      render(<ModelSelect />);
      expect(
        within(rowNamed('DeepSeek')).getByTestId('model-limit-badge'),
      ).toHaveAttribute('aria-label', 'exhaustedNoReset');
    });

    it('a click reveals the inline note and selects nothing (no conversation update, no default)', () => {
      // The whole DeepSeek family is spent, so the row cannot route around
      // it onto a sibling (conversation stays on GPT so nothing is selected
      // in that family).
      limitsState.models = Object.fromEntries(
        mockUseSettings.models
          .filter((m) => m.series === 'deepseek')
          .map((m) => [m.id, exhausted()]),
      );
      render(<ModelSelect />);

      const row = rowNamed('DeepSeek');
      expect(screen.queryByTestId('model-limit-note')).toBeNull();
      fireEvent.click(row);

      expect(screen.getByTestId('model-limit-note')).toHaveTextContent(
        'exhausted',
      );
      expect(mockUseConversations.updateConversation).not.toHaveBeenCalled();
      expect(mockUseSettings.setDefaultModelId).not.toHaveBeenCalled();

      // Second tap folds the note away again.
      fireEvent.click(row);
      expect(screen.queryByTestId('model-limit-note')).toBeNull();
    });

    it('family-exhausted members carry the family wording', () => {
      mockUseConversations.selectedConversation = conversationOn(
        OpenAIModelID.DEEPSEEK_V3_1,
      );
      limitsState.models = Object.fromEntries(
        mockUseSettings.models
          .filter((m) => m.series === 'deepseek')
          .map((m) => [m.id, exhausted({ reason: 'familyExhausted' })]),
      );
      render(<ModelSelect />);
      expect(
        within(rowNamed('DeepSeek')).getByTestId('model-limit-badge'),
      ).toHaveAttribute('aria-label', 'familyExhausted');
    });
  });

  describe('family rows', () => {
    it('fronts a still-usable sibling when the family default is spent, so the row stays clickable', () => {
      // Nothing in the GPT family is selected (conversation on DeepSeek):
      // the default representative is the newest rank-1 member, GPT-5.5.
      mockUseConversations.selectedConversation = conversationOn(
        OpenAIModelID.DEEPSEEK_V3_1,
      );
      limitsState.models = { 'gpt-5.5': exhausted() };
      render(<ModelSelect />);

      const row = rowNamed('GPT');
      expect(row).not.toHaveAttribute('aria-disabled');
      // The inline version tag names the sibling that now fronts the row.
      expect(within(row).getByText('5.4')).toBeInTheDocument();
      fireEvent.click(row);
      expect(mockUseConversations.updateConversation).toHaveBeenCalledWith(
        'conv-1',
        expect.objectContaining({
          model: expect.objectContaining({ id: 'gpt-5.4' }),
        }),
      );
      expect(mockUseSettings.setDefaultModelId).toHaveBeenCalledWith('gpt-5.4');
    });

    it('keeps fronting the CURRENT model when it is the one that is spent (selection wins)', () => {
      limitsState.models = { [OpenAIModelID.GPT_5_2]: exhausted() };
      render(<ModelSelect />);
      const row = rowNamed('GPT');
      expect(within(row).getByText('5.2')).toBeInTheDocument();
      expect(row).toHaveAttribute('aria-disabled', 'true');
    });
  });

  describe('details panel switchers', () => {
    it('disables an exhausted Version chip and refuses to select it', () => {
      // Conversation on GPT-5.2; GPT-5 (same standard variant) is spent.
      limitsState.models = { [OpenAIModelID.GPT_5]: exhausted() };
      render(<ModelSelect />);

      const chip = screen.getByTitle('GPT-5');
      expect(chip).toHaveAttribute('aria-disabled', 'true');
      expect(within(chip).getByTestId('model-limit-badge')).toBeInTheDocument();
      fireEvent.click(chip);
      expect(mockUseSettings.setDefaultModelId).not.toHaveBeenCalled();
      expect(mockUseConversations.updateConversation).not.toHaveBeenCalled();

      // A usable sibling chip still works.
      fireEvent.click(screen.getByTitle('GPT-5.4'));
      expect(mockUseSettings.setDefaultModelId).toHaveBeenCalledWith(
        OpenAIModelID.GPT_5_4,
      );
    });

    it('routes a Variant segment onto a usable version and disables it only when the whole variant is spent', () => {
      const minis = mockUseSettings.models.filter(
        (m) => m.series === 'gpt' && m.variant === 'mini',
      );
      // Every Mini spent → the segment is disabled with the badge.
      limitsState.models = Object.fromEntries(
        minis.map((m) => [m.id, exhausted()]),
      );
      const { unmount } = render(<ModelSelect />);
      const group = () => screen.getByRole('group', { name: 'Variant' });
      const mini = () => within(group()).getByText('Mini').closest('button')!;
      expect(mini()).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(mini());
      expect(mockUseConversations.updateConversation).not.toHaveBeenCalled();
      unmount();

      // Only the newest Mini spent → the segment stays enabled and lands
      // on an older, still-usable Mini instead.
      const newestMini = minis.reduce((a, b) =>
        parseFloat(a.versionLabel ?? '0') >= parseFloat(b.versionLabel ?? '0')
          ? a
          : b,
      );
      limitsState.models = { [newestMini.id]: exhausted() };
      render(<ModelSelect />);
      expect(mini()).not.toHaveAttribute('aria-disabled');
      fireEvent.click(mini());
      const picked = mockUseConversations.updateConversation.mock.calls[0][1]
        .model.id as string;
      expect(picked).not.toBe(newestMini.id);
      expect(minis.some((m) => m.id === picked)).toBe(true);
    });
  });

  describe('low-remaining annotation', () => {
    it('shows "{remaining} left" at or under 10 % of the cap (never below 1)', () => {
      mockUseConversations.selectedConversation = conversationOn(
        OpenAIModelID.DEEPSEEK_V3_1,
      );
      limitsState.models = {
        [OpenAIModelID.DEEPSEEK_V3_1]: {
          allowed: true,
          limit: 20,
          used: 18,
          remaining: 2,
          resetAt: IN_SIX_HOURS(),
        },
      };
      render(<ModelSelect />);
      const row = rowNamed('DeepSeek');
      expect(
        within(row).getByTestId('model-limit-remaining'),
      ).toBeInTheDocument();
      expect(within(row).queryByTestId('model-limit-badge')).toBeNull();
      // Still selectable.
      expect(row).not.toHaveAttribute('aria-disabled');
    });

    it('stays quiet above the threshold', () => {
      mockUseConversations.selectedConversation = conversationOn(
        OpenAIModelID.DEEPSEEK_V3_1,
      );
      limitsState.models = {
        [OpenAIModelID.DEEPSEEK_V3_1]: {
          allowed: true,
          limit: 20,
          used: 17,
          remaining: 3,
        },
      };
      render(<ModelSelect />);
      expect(screen.queryByTestId('model-limit-remaining')).toBeNull();
    });
  });

  describe('header parity', () => {
    it('shows the badge and a prose note on the details header for the current model', () => {
      limitsState.models = { [OpenAIModelID.GPT_5_2]: exhausted() };
      render(<ModelSelect />);
      expect(screen.getByTestId('model-limit-header-note')).toHaveTextContent(
        'exhausted',
      );
    });
  });
});
