import { act, render, screen } from '@testing-library/react';

import type {
  MeLimit,
  ModelAvailability,
} from '@/client/hooks/settings/useMyLimits';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import {
  YourLimitsTable,
  selectYourLimitRows,
} from '@/components/Settings/Sections/YourLimitsTable';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { LIMIT_DEFINITIONS } from '@/config/limits';
import enMessages from '@/messages/en.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The global setup mock knows nothing about `limits.*` / `limitsUx.*`, and
// this block's whole value is that it reuses the admin catalog copy, so
// translate from the REAL en.json here (namespace-less, like the component).
// ---------------------------------------------------------------------------
function lookup(key: string): string | undefined {
  let current: unknown = enMessages;
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

vi.mock('next-intl', () => ({
  useTranslations:
    () => (key: string, params?: Record<string, string | number>) => {
      let value = lookup(key) ?? key;
      for (const [k, v] of Object.entries(params ?? {})) {
        value = value.replace(`{${k}}`, String(v));
      }
      return value;
    },
  useLocale: () => 'en',
}));

const mockUseMyLimits = vi.fn();
vi.mock('@/client/hooks/settings/useMyLimits', async (importOriginal) => ({
  // Keep the real useResetCountdown so the countdown assertion is genuine.
  ...(await importOriginal<
    typeof import('@/client/hooks/settings/useMyLimits')
  >()),
  useMyLimits: () => mockUseMyLimits(),
}));

const HOUR_MS = 60 * 60 * 1000;

function limitsState(
  overrides: Partial<{
    enforce: boolean;
    limits: MeLimit[];
    models: Record<string, ModelAvailability>;
    usageUnavailable: boolean;
    refetch: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    enforce: true,
    limits: [],
    models: {},
    usageUnavailable: false,
    policyUnavailable: false,
    mode: 'enforce',
    isLimited: true,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

const counter = (
  limitKey: string,
  value: number,
  extra: Partial<MeLimit> = {},
): MeLimit => ({
  limitKey,
  value,
  unit: 'requests',
  window: 'day',
  source: 'global',
  ...extra,
});

describe('YourLimitsTable', () => {
  let resetAt: string;

  beforeEach(() => {
    resetAt = new Date(Date.now() + 6 * HOUR_MS + 30_000).toISOString();
    useSettingsStore.setState({ models: Object.values(OpenAIModels) });
    mockUseMyLimits.mockReturnValue(limitsState());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when the policy is not enforced, even with rows', () => {
    mockUseMyLimits.mockReturnValue(
      limitsState({
        enforce: false,
        limits: [counter('chat.messagesPerDay', 20, { used: 12 })],
      }),
    );
    const { container } = render(<YourLimitsTable />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when enforced but nothing constrains the caller', () => {
    const { container } = render(<YourLimitsTable />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides untouched catalog defaults so the block stays empty for the unlimited majority', () => {
    mockUseMyLimits.mockReturnValue(
      limitsState({
        limits: [
          counter('feature.m365.mail.draftsPerDay', 25, {
            source: 'catalog',
            used: 0,
            remaining: 25,
            resetAt,
          }),
          {
            limitKey: 'feature.mcp.roundsPerRequest',
            value: 5,
            unit: 'rounds',
            window: 'request',
            source: 'catalog',
          },
        ],
      }),
    );
    const { container } = render(<YourLimitsTable />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders counters as used / limit with a live reset countdown', () => {
    mockUseMyLimits.mockReturnValue(
      limitsState({
        limits: [
          counter('chat.messagesPerDay', 20, {
            used: 12,
            remaining: 8,
            resetAt,
          }),
        ],
      }),
    );
    render(<YourLimitsTable />);

    expect(screen.getByText('Your limits')).toBeInTheDocument();
    expect(screen.getByText('Messages per day')).toBeInTheDocument();
    expect(screen.getByText('12 / 20 requests')).toBeInTheDocument();
    // Real useResetCountdown → Intl.RelativeTimeFormat("in 7 hours" after ceil).
    expect(screen.getByText(/^Resets in \d+ hours?$/)).toBeInTheDocument();
    // Not exhausted: no chip.
    expect(screen.queryByText('Limit reached')).not.toBeInTheDocument();
  });

  it('renders boolean gates as "Not available" with no countdown', () => {
    mockUseMyLimits.mockReturnValue(
      limitsState({
        limits: [
          {
            limitKey: 'feature.webSearch.enabled',
            value: false,
            unit: 'boolean',
            window: 'none',
            source: 'override',
          },
        ],
      }),
    );
    render(<YourLimitsTable />);
    expect(screen.getByText('Web search')).toBeInTheDocument();
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.queryByText(/^Resets/)).not.toBeInTheDocument();
  });

  it('renders per-request ceilings and usage-less counters as the bare limit', () => {
    mockUseMyLimits.mockReturnValue(
      limitsState({
        usageUnavailable: true,
        limits: [
          {
            limitKey: 'feature.upload.megabytesPerFile',
            value: 20,
            unit: 'megabytes',
            window: 'request',
            source: 'global',
          },
          counter('chat.tokensPerDay', 1_000_000, { unit: 'tokens' }),
        ],
      }),
    );
    render(<YourLimitsTable />);
    expect(screen.getByText('Upload size per file')).toBeInTheDocument();
    expect(screen.getByText('20 MB')).toBeInTheDocument();
    expect(screen.getByText('1,000,000 tokens')).toBeInTheDocument();
    expect(
      screen.getByText(/Current usage could not be loaded/),
    ).toBeInTheDocument();
  });

  it('keeps a catalog default once the user has consumed some of it', () => {
    mockUseMyLimits.mockReturnValue(
      limitsState({
        limits: [
          counter('feature.m365.mail.draftsPerDay', 25, {
            source: 'catalog',
            unit: 'calls',
            used: 3,
            remaining: 22,
            resetAt,
          }),
        ],
      }),
    );
    render(<YourLimitsTable />);
    expect(screen.getByText('Mail drafts per day')).toBeInTheDocument();
    expect(screen.getByText('3 / 25 calls')).toBeInTheDocument();
  });

  it('renders per-model rows by display name and flags exhaustion', () => {
    mockUseMyLimits.mockReturnValue(
      limitsState({
        models: {
          [OpenAIModelID.GPT_5_2]: {
            allowed: true,
            limit: 50,
            used: 50,
            remaining: 0,
            reason: 'exhausted',
            resetAt,
          },
          [OpenAIModelID.DEEPSEEK_R1]: {
            allowed: true,
            limit: 10,
            used: 10,
            remaining: 0,
            reason: 'familyExhausted',
            resetAt,
          },
          // No numeric cap → not constraining → no row.
          [OpenAIModelID.GPT_o3]: { allowed: true },
        },
      }),
    );
    render(<YourLimitsTable />);
    expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
    expect(screen.getByText('50 / 50 requests')).toBeInTheDocument();
    expect(screen.getByText('Limit reached')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek-R1')).toBeInTheDocument();
    expect(screen.getByText('Model family limit reached')).toBeInTheDocument();
    expect(screen.getAllByText(/^Resets in/)).toHaveLength(2);
    expect(
      screen.queryByText(OpenAIModels[OpenAIModelID.GPT_o3].name),
    ).not.toBeInTheDocument();
  });

  it('shows a blocked model as "Not available"', () => {
    mockUseMyLimits.mockReturnValue(
      limitsState({
        models: {
          [OpenAIModelID.GPT_5_2]: { allowed: false, reason: 'blocked' },
        },
      }),
    );
    render(<YourLimitsTable />);
    expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
    expect(screen.getByText('Not available')).toBeInTheDocument();
  });

  it('does not repeat the chat message cap once per model, even with a drifted resetAt', () => {
    // Production shape: the chat row's and the model row's `resetAt` come
    // from two separate `periods.resetAt()` calls and differ by whatever
    // millisecond each call landed on — the dedup must not key on them.
    const cap = counter('chat.messagesPerDay', 20, {
      used: 4,
      remaining: 16,
      resetAt,
    });
    const drifted = new Date(new Date(resetAt).getTime() + 37).toISOString();
    mockUseMyLimits.mockReturnValue(
      limitsState({
        limits: [cap],
        models: {
          // Same (limit, used) as the chat row but a DIFFERENT resetAt →
          // still skipped, because it's the same binding cell.
          [OpenAIModelID.GPT_5_2]: {
            allowed: true,
            limit: 20,
            used: 4,
            remaining: 16,
            resetAt: drifted,
          },
          // Its own per-model cap → shown.
          [OpenAIModelID.DEEPSEEK_R1]: {
            allowed: true,
            limit: 5,
            used: 1,
            remaining: 4,
            resetAt,
          },
        },
      }),
    );
    render(<YourLimitsTable />);
    expect(screen.getByText('Messages per day')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5.2')).not.toBeInTheDocument();
    expect(screen.getByText('DeepSeek-R1')).toBeInTheDocument();
    expect(screen.getByText('1 / 5 requests')).toBeInTheDocument();
  });

  it('still dedups the chat cap when usage is unavailable and the chat row has no resetAt at all', () => {
    mockUseMyLimits.mockReturnValue(
      limitsState({
        usageUnavailable: true,
        limits: [counter('chat.messagesPerDay', 20, { used: 4 })],
        models: {
          [OpenAIModelID.GPT_5_2]: {
            allowed: true,
            limit: 20,
            used: 4,
            resetAt,
          },
        },
      }),
    );
    render(<YourLimitsTable />);
    expect(screen.getByText('Messages per day')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5.2')).not.toBeInTheDocument();
  });

  it('skips an unqualified model.requests default in favor of the model-specific answer', () => {
    // A bare `model.requests` row is only the compiled default — no counter
    // is ever written under the unqualified key — so it must not render a
    // phantom "0 / N" line next to the real per-model row.
    mockUseMyLimits.mockReturnValue(
      limitsState({
        limits: [
          {
            limitKey: 'model.requests',
            value: 50,
            unit: 'requests',
            window: 'day',
            source: 'global',
            used: 0,
            remaining: 50,
          },
        ],
        models: {
          [OpenAIModelID.GPT_5_2]: {
            allowed: true,
            limit: 50,
            used: 50,
            remaining: 0,
            reason: 'exhausted',
            resetAt,
          },
        },
      }),
    );
    render(<YourLimitsTable />);
    expect(screen.getByText('GPT-5.2')).toBeInTheDocument();
    expect(screen.getByText('50 / 50 requests')).toBeInTheDocument();
    expect(screen.queryByText('Messages per model')).not.toBeInTheDocument();
    expect(screen.queryByText('0 / 50 requests')).not.toBeInTheDocument();
  });

  it('skips an unqualified model.allowed default (models already carries the per-model verdict)', () => {
    const rows = selectYourLimitRows(
      [
        {
          limitKey: 'model.allowed',
          value: false,
          unit: 'boolean',
          window: 'none',
          source: 'global',
        },
      ],
      { [OpenAIModelID.GPT_5_2]: { allowed: false, reason: 'blocked' } },
      (id) => id,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        id: `model:${OpenAIModelID.GPT_5_2}`,
        blocked: true,
      }),
    ]);
  });

  it('collapses a shared family envelope into one row instead of one per model', () => {
    mockUseMyLimits.mockReturnValue(
      limitsState({
        models: {
          [OpenAIModelID.GPT_5_2]: {
            allowed: true,
            limit: 100,
            used: 40,
            remaining: 60,
            resetAt,
          },
          [OpenAIModelID.GPT_5_MINI]: {
            allowed: true,
            limit: 100,
            used: 40,
            remaining: 60,
            resetAt,
          },
        },
      }),
    );
    render(<YourLimitsTable />);
    expect(screen.getByText('GPT models')).toBeInTheDocument();
    expect(screen.getByText('40 / 100 requests')).toBeInTheDocument();
    expect(screen.queryByText('GPT-5.2')).not.toBeInTheDocument();
    expect(screen.queryByText('GPT-5 Mini')).not.toBeInTheDocument();
    // One row, one countdown — not two.
    expect(screen.getAllByText(/^Resets in/)).toHaveLength(1);
  });

  it('does not collapse two models in the same family whose numbers differ', () => {
    const rows = selectYourLimitRows(
      [],
      {
        modelA: { allowed: true, limit: 100, used: 40, resetAt },
        modelB: { allowed: true, limit: 100, used: 12, resetAt },
      },
      (id) => id,
      () => 'GPT',
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.isFamilyRow)).toBe(true);
  });

  it('refetches once a countdown expires, so an exhausted row does not linger past the reset', async () => {
    vi.useFakeTimers();
    try {
      const refetch = vi.fn();
      const soon = new Date(Date.now() + 1000).toISOString();
      mockUseMyLimits.mockReturnValue(
        limitsState({
          limits: [
            counter('chat.messagesPerDay', 20, {
              used: 20,
              remaining: 0,
              resetAt: soon,
            }),
          ],
          refetch,
        }),
      );
      render(<YourLimitsTable />);
      expect(screen.getByText('Limit reached')).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(refetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the id for a model the client cannot name', () => {
    const rows = selectYourLimitRows(
      [],
      { 'mystery-model': { allowed: true, limit: 3 } },
      (id) => id,
    );
    expect(rows).toEqual([
      expect.objectContaining({ modelName: 'mystery-model', limit: 3 }),
    ]);
  });

  it('skips a key this build cannot label rather than leaking it', () => {
    const rows = selectYourLimitRows(
      [counter('feature.future.thing', 3, { used: 1 })],
      {},
      (id) => id,
    );
    expect(rows).toEqual([]);
  });
});

/**
 * Drift guard: the block labels rows with the admin catalog copy
 * (`limits.label.<labelKey>`) and units (`limits.unit.<unit>`), so a new
 * catalog key without copy would render as a raw key to end users.
 */
describe('YourLimitsTable label coverage', () => {
  it('has en.json copy for every catalog key and unit', () => {
    for (const def of LIMIT_DEFINITIONS) {
      expect(
        lookup(`limits.label.${def.labelKey}`),
        `missing limits.label.${def.labelKey} for ${def.key}`,
      ).toBeTruthy();
      expect(
        lookup(`limits.unit.${def.unit}`),
        `missing limits.unit.${def.unit} for ${def.key}`,
      ).toBeDefined();
    }
  });

  it('has en.json copy for every limitsUx.mine key the block renders', () => {
    for (const key of [
      'title',
      'description',
      'notAvailable',
      'usedOfLimit',
      'limitOnly',
      'resetsIn',
      'limitReached',
      'familyLimitReached',
      'familyRow',
      'usageUnavailable',
    ]) {
      expect(lookup(`limitsUx.mine.${key}`), key).toBeTruthy();
    }
  });
});
