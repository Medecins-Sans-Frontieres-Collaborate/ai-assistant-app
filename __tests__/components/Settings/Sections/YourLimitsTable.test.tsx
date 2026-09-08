import { render, screen } from '@testing-library/react';

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

  it('does not repeat the chat message cap once per model', () => {
    const cap = counter('chat.messagesPerDay', 20, {
      used: 4,
      remaining: 16,
      resetAt,
    });
    mockUseMyLimits.mockReturnValue(
      limitsState({
        limits: [cap],
        models: {
          // Same binding cell as the chat row → skipped.
          [OpenAIModelID.GPT_5_2]: {
            allowed: true,
            limit: 20,
            used: 4,
            remaining: 16,
            resetAt,
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
      'usageUnavailable',
    ]) {
      expect(lookup(`limitsUx.mine.${key}`), key).toBeTruthy();
    }
  });
});
